/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * 视频缓存（R2，全局共享）。
 *
 * 设计要点：
 * - 以「单集」为单位缓存：缓存该集的 m3u8（已改写）与其 ts 分片；
 * - 存储键 `v/<epHash>/...`，epHash = sha256(该集原始 m3u8 地址)，与用户无关 → 同一集只存一份；
 * - 播放列表在服务端改写：分片相对地址解析为绝对地址后改为走本站代理，
 *   （WebKit 原生 HLS 不经过 hls.js，改写必须做在服务端，否则浏览器会按 /api/ 解析相对路径）；
 * - 回源受 Worker 单次调用的子请求数与 CPU 限制，整集缓存按批次进行，由前端循环驱动。
 */

/** 单次批量缓存的分片数：受 Worker 单次调用子请求数限制，须保守 */
export const CACHE_BATCH_SIZE = 10;
/** 单次批量删除的对象数 */
const DELETE_BATCH_SIZE = 40;
/** 单个分片写入缓存的体积上限（32MB），超过则不缓存，避免 Worker 内存溢出 */
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;

export interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  size?: number;
  customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: ArrayBuffer | string, options?: any): Promise<any>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<R2ObjectLike | null>;
  list(options?: any): Promise<{
    objects: Array<{ key: string; size?: number; customMetadata?: Record<string, string> }>;
    delimitedPrefixes?: string[];
    truncated?: boolean;
    cursor?: string;
  }>;
}

function getCloudflareContext(): any {
  try {
    return (globalThis as any)[Symbol.for('__cloudflare-context__')];
  } catch {
    return null;
  }
}

export function getVideoCacheBucket(): R2BucketLike | null {
  try {
    const ctx = getCloudflareContext();
    const bucket = ctx?.env?.VIDEO_CACHE;
    if (bucket && typeof bucket.get === 'function') return bucket as R2BucketLike;
  } catch {
    // ignore
  }
  return null;
}

export function runInBackground(promise: Promise<unknown>) {
  const safe = promise.catch((err) => {
    console.error('[video-cache] background task failed:', err);
  });
  try {
    const ctx = getCloudflareContext();
    const execution = ctx?.ctx ?? ctx;
    if (execution?.waitUntil) {
      execution.waitUntil(safe);
      return;
    }
  } catch {
    // ignore
  }
}

/* ---------------- 编码与哈希 ---------------- */

export function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64url');
}

export function fromBase64Url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf-8');
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ---------------- 回源（含 SSRF 防护） ---------------- */

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return false;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

export function parseSafeUrl(raw: string): URL | null {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  if (isBlockedHost(target.hostname)) return null;
  return target;
}

export async function fetchUpstream(target: URL): Promise<Response> {
  const host = target.hostname.toLowerCase();
  const referer = host.includes('douban') ? 'https://movie.douban.com/' : `${target.origin}/`;
  return fetch(target.toString(), {
    headers: {
      Referer: referer,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Accept: '*/*',
    },
  });
}

/* ---------------- 存储键 ---------------- */

export async function episodeHash(episodeUrl: string): Promise<string> {
  return sha256Hex(episodeUrl);
}

export function playlistKey(epHash: string): string {
  return `v/${epHash}/playlist.m3u8`;
}

export async function segmentKey(epHash: string, segmentUrl: string): Promise<string> {
  return `v/${epHash}/s/${await sha256Hex(segmentUrl)}`;
}

/* ---------------- m3u8 改写 ---------------- */

const PLAYLIST_PATTERN = /\.m3u8(\?|$)/i;

export function isPlaylistUrl(url: string): boolean {
  return PLAYLIST_PATTERN.test(url);
}

/** 生成本站代理地址：u=目标绝对地址，ep=所属集哈希 */
export function buildProxyUrl(target: string, epHash: string): string {
  return `/api/video-cache?u=${toBase64Url(target)}&ep=${epHash}`;
}

interface RewriteResult {
  text: string;
  /** 分片（含子播放列表）的绝对地址，按出现顺序 */
  refs: string[];
}

/**
 * 将 m3u8 内的引用地址（分片 / 密钥 / 子播放列表）解析为绝对地址后改写为本站代理地址。
 */
export function rewritePlaylist(
  text: string,
  playlistUrl: string,
  epHash: string
): RewriteResult {
  const refs: string[] = [];
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();

    // 属性行中的 URI="..."（#EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 等）
    if (trimmed.startsWith('#') && trimmed.includes('URI=')) {
      return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
        try {
          const abs = new URL(uri, playlistUrl).toString();
          return `URI="${buildProxyUrl(abs, epHash)}"`;
        } catch {
          return `URI="${uri}"`;
        }
      });
    }

    if (trimmed.startsWith('#') || trimmed === '') return line;

    // 分片或子播放列表
    try {
      const abs = new URL(trimmed, playlistUrl).toString();
      refs.push(abs);
      return buildProxyUrl(abs, epHash);
    } catch {
      return line;
    }
  });
  return { text: out.join('\n'), refs };
}

/* ---------------- 播放列表读写 ---------------- */

export interface PlaylistInfo {
  epHash: string;
  text: string;
  refs: string[];
  fromCache: boolean;
  metadata: Record<string, string>;
}

/** 归属信息：用于按「影片」聚合展示缓存列表 */
export interface EpisodeMeta {
  source?: string;
  vid?: string;
  epIndex?: number;
  epTotal?: number;
}

/** 组装播放列表的自定义元数据（播放列表本身很小，重复写入代价可接受） */
function buildPlaylistMetadata(
  episodeUrl: string,
  title: string,
  extra: EpisodeMeta | undefined,
  prev: Record<string, string> | undefined,
  bytes: string
): Record<string, string> {
  return {
    src: episodeUrl.slice(0, 512),
    title: (title || prev?.title || '').slice(0, 200),
    count: prev?.count ?? '0',
    lastAccess: prev?.lastAccess ?? String(Date.now()),
    bytes,
    // 归属信息：优先用本次传入，其次沿用已有值
    source: (extra?.source ?? prev?.source ?? '').slice(0, 100),
    vid: (extra?.vid ?? prev?.vid ?? '').slice(0, 100),
    epIndex: String(extra?.epIndex ?? (prev?.epIndex ? Number(prev.epIndex) : -1)),
    epTotal: String(extra?.epTotal ?? (prev?.epTotal ? Number(prev.epTotal) : 0)),
  };
}

/** 取已改写的播放列表：命中缓存直接返回；否则回源、改写并写入缓存 */
export async function getOrCreatePlaylist(
  episodeUrl: string,
  title?: string,
  extra?: EpisodeMeta
): Promise<PlaylistInfo> {
  const bucket = getVideoCacheBucket();
  if (!bucket) throw new Error('VIDEO_CACHE 未绑定');

  const epHash = await episodeHash(episodeUrl);
  const key = playlistKey(epHash);

  const cached = await bucket.get(key);
  if (cached) {
    const text = await cached.text();
    const prev = cached.customMetadata ?? {};
    // 补齐/更新归属信息（例如缓存在旧版本创建的、或首次缓存时未带片名）
    if (
      (extra?.source && extra.source !== prev.source) ||
      (extra?.vid && extra.vid !== prev.vid) ||
      (extra?.epIndex != null && String(extra.epIndex) !== prev.epIndex) ||
      (title && title !== prev.title)
    ) {
      await bucket.put(key, text, {
        customMetadata: buildPlaylistMetadata(
          episodeUrl,
          title ?? '',
          extra,
          prev,
          prev.bytes ?? '0'
        ),
      });
    }
    return {
      epHash,
      text,
      refs: parseRefsFromRewritten(text),
      fromCache: true,
      metadata: cached.customMetadata ?? {},
    };
  }

  const target = parseSafeUrl(episodeUrl);
  if (!target) throw new Error('非法的播放地址');

  const res = await fetchUpstream(target);
  if (!res.ok) throw new Error(`回源播放列表失败: ${res.status}`);

  const original = await res.text();
  const { text, refs } = rewritePlaylist(original, episodeUrl, epHash);
  await bucket.put(key, text, {
    customMetadata: buildPlaylistMetadata(episodeUrl, title ?? '', extra, undefined, '0'),
  });

  return { epHash, text, refs, fromCache: false, metadata: {} };
}

/** 从已改写的播放列表里还原引用的原始绝对地址 */
function parseRefsFromRewritten(text: string): string[] {
  const refs: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    const m = /[?&]u=([A-Za-z0-9_-]+)/.exec(trimmed);
    if (m) {
      try {
        refs.push(fromBase64Url(m[1]));
      } catch {
        // ignore
      }
    }
  }
  return refs;
}

/* ---------------- 整集缓存（分批） ---------------- */

export interface CacheBatchResult {
  epHash: string;
  /** 该集引用总数（含子播放列表时以顶级列表为准） */
  total: number;
  /** 本次处理后应请求的下一批起始下标 */
  nextOffset: number;
  cachedNow: number;
  skipped: number;
  bytesAdded: number;
  done: boolean;
}

/**
 * 解析出真正需要缓存的分片地址。
 * 顶级列表可能是多码率 master（引用的是子播放列表），需下钻一层取得分片；
 * 多码率只跟踪第一路，避免整集缓存体积失控。
 */
async function resolveSegments(epHash: string, refs: string[]): Promise<string[]> {
  const segments: string[] = [];
  let followed = false;
  for (const ref of refs) {
    if (!isPlaylistUrl(ref)) {
      segments.push(ref);
      continue;
    }
    if (followed) continue;
    followed = true;
    try {
      const target = parseSafeUrl(ref);
      if (!target) continue;
      const res = await fetchUpstream(target);
      if (!res.ok) continue;
      const { refs: subRefs } = rewritePlaylist(await res.text(), ref, epHash);
      for (const s of subRefs) {
        if (!isPlaylistUrl(s)) segments.push(s);
      }
    } catch (err) {
      console.error('[video-cache] 解析子播放列表失败:', ref, err);
    }
  }
  return segments;
}

/**
 * 缓存一批分片。前端按 nextOffset 循环调用直到 done。
 * 已存在的分片会跳过（head 检查），因此重复调用是安全的，可用于「后续补全缓存」。
 */
export async function cacheSegmentBatch(
  episodeUrl: string,
  offset: number,
  title?: string,
  extra?: EpisodeMeta
): Promise<CacheBatchResult> {
  const bucket = getVideoCacheBucket();
  if (!bucket) throw new Error('VIDEO_CACHE 未绑定');

  const { epHash, refs } = await getOrCreatePlaylist(episodeUrl, title, extra);
  const segments = await resolveSegments(epHash, refs);
  const batch = segments.slice(offset, offset + CACHE_BATCH_SIZE);

  let cachedNow = 0;
  let skipped = 0;
  let bytesAdded = 0;

  for (const ref of batch) {
    const key = await segmentKey(epHash, ref);
    // 已缓存则跳过（支持断点续传与后续补全）
    const existing = await bucket.head(key);
    if (existing) {
      skipped++;
      continue;
    }

    const target = parseSafeUrl(ref);
    if (!target) continue;

    const res = await fetchUpstream(target);
    if (!res.ok) continue;

    // 超大对象不缓存（如 EXT-X-MAP 指向的整段 mp4 可达上百 MB），否则 Worker 内存溢出；
    // 这类资源播放时仍由代理流式透传。
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_SEGMENT_BYTES) continue;

    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) continue;
    if (buf.byteLength > MAX_SEGMENT_BYTES) continue;

    await bucket.put(key, buf, {
      customMetadata: {
        src: ref.slice(0, 512),
        ct: res.headers.get('content-type') || 'video/mp2t',
      },
    });
    cachedNow++;
    bytesAdded += buf.byteLength;
  }

  // 更新本集累计字节与归属信息（播放列表很小，重写代价可接受）
  const plKey = playlistKey(epHash);
  const pl = await bucket.get(plKey);
  if (pl) {
    const prev = pl.customMetadata ?? {};
    const prevBytes = Number(prev.bytes ?? '0') || 0;
    await bucket.put(plKey, await pl.text(), {
      customMetadata: buildPlaylistMetadata(
        episodeUrl,
        title ?? '',
        extra,
        prev,
        String(prevBytes + bytesAdded)
      ),
    });
  }

  const nextOffset = offset + batch.length;
  return {
    epHash,
    total: segments.length,
    nextOffset,
    cachedNow,
    skipped,
    bytesAdded,
    done: nextOffset >= segments.length,
  };
}

/* ---------------- 状态与统计 ---------------- */

export interface EpisodeStatus {
  available: boolean;
  epHash: string;
  cached: boolean;
  segmentsTotal: number;
  bytes: number;
  title: string;
}

export async function getEpisodeStatus(episodeUrl: string): Promise<EpisodeStatus> {
  const bucket = getVideoCacheBucket();
  if (!bucket) {
    return { available: false, epHash: '', cached: false, segmentsTotal: 0, bytes: 0, title: '' };
  }
  const epHash = await episodeHash(episodeUrl);
  const pl = await bucket.get(playlistKey(epHash));
  if (!pl) {
    return { available: true, epHash, cached: false, segmentsTotal: 0, bytes: 0, title: '' };
  }
  const text = await pl.text();
  const bytes = Number(pl.customMetadata?.bytes ?? '0') || 0;
  return {
    available: true,
    epHash,
    cached: bytes > 0,
    segmentsTotal: parseRefsFromRewritten(text).length,
    bytes,
    title: pl.customMetadata?.title ?? '',
  };
}

export interface EpisodeEntry {
  epHash: string;
  src: string;
  title: string;
  bytes: number;
  count: number;
  lastAccess: number;
  /** 归属影片（用于聚合展示，旧数据可能为空） */
  source: string;
  vid: string;
  /** 集号（0 基，-1 表示未知） */
  epIndex: number;
  /** 该影片总集数（0 表示未知） */
  epTotal: number;
}

/** 列出所有已缓存的集（读各集播放列表元数据） */
export async function listEpisodes(): Promise<EpisodeEntry[]> {
  const bucket = getVideoCacheBucket();
  if (!bucket) return [];

  const prefixes: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(
      cursor
        ? { prefix: 'v/', delimiter: '/', limit: 1000, cursor }
        : { prefix: 'v/', delimiter: '/', limit: 1000 }
    );
    prefixes.push(...(page.delimitedPrefixes ?? []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const entries: EpisodeEntry[] = [];
  for (const prefix of prefixes) {
    const epHash = prefix.replace(/^v\//, '').replace(/\/$/, '');
    if (!epHash) continue;
    try {
      const pl = await bucket.get(playlistKey(epHash));
      if (!pl) continue;
      const meta = pl.customMetadata ?? {};
      entries.push({
        epHash,
        src: meta.src ?? '',
        title: meta.title ?? '',
        bytes: Number(meta.bytes ?? '0') || 0,
        count: Number(meta.count ?? '0') || 0,
        lastAccess: Number(meta.lastAccess ?? '0') || 0,
        source: meta.source ?? '',
        vid: meta.vid ?? '',
        epIndex: meta.epIndex != null ? Number(meta.epIndex) : -1,
        epTotal: meta.epTotal != null ? Number(meta.epTotal) : 0,
      });
    } catch (err) {
      console.error('[video-cache] 读取集信息失败:', epHash, err);
    }
  }
  return entries.sort((a, b) => b.lastAccess - a.lastAccess);
}

export interface VideoCacheStats {
  available: boolean;
  episodes: number;
  bytes: number;
}

export async function getVideoCacheStats(): Promise<VideoCacheStats> {
  const bucket = getVideoCacheBucket();
  if (!bucket) return { available: false, episodes: 0, bytes: 0 };
  const entries = await listEpisodes();
  return {
    available: true,
    episodes: entries.length,
    bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
  };
}

/* ---------------- 删除与容量淘汰 ---------------- */

async function listKeysUnderPrefix(bucket: R2BucketLike, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(
      cursor ? { prefix, limit: 1000, cursor } : { prefix, limit: 1000 }
    );
    keys.push(...(page.objects ?? []).map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** 删除一集；遇子请求上限时保留已完成部分并返回 complete=false */
async function deleteEpisodeByHash(
  bucket: R2BucketLike,
  epHash: string
): Promise<{ deleted: number; complete: boolean }> {
  const keys = await listKeysUnderPrefix(bucket, `v/${epHash}/`);
  let deleted = 0;
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const chunk = keys.slice(i, i + DELETE_BATCH_SIZE);
    try {
      await Promise.all(chunk.map((k) => bucket.delete(k)));
      deleted += chunk.length;
    } catch (err) {
      console.error('[video-cache] 删除批次失败（可能触及子请求上限）:', err);
      return { deleted, complete: false };
    }
  }
  return { deleted, complete: true };
}

export async function deleteEpisode(
  episodeUrl: string
): Promise<{ deleted: number; complete: boolean }> {
  const bucket = getVideoCacheBucket();
  if (!bucket) return { deleted: 0, complete: false };
  const epHash = await episodeHash(episodeUrl);
  return deleteEpisodeByHash(bucket, epHash);
}

export interface EvictResult {
  limitBytes: number;
  beforeBytes: number;
  afterBytes: number;
  removedEpisodes: number;
  incomplete: boolean;
}

/**
 * 容量上限淘汰：按「最近访问时间」升序整集删除，直到总占用低于上限。
 * limitBytes <= 0 表示不限制。
 */
export async function evictVideoCache(limitBytes: number): Promise<EvictResult> {
  const empty: EvictResult = {
    limitBytes,
    beforeBytes: 0,
    afterBytes: 0,
    removedEpisodes: 0,
    incomplete: false,
  };
  const bucket = getVideoCacheBucket();
  if (!bucket || limitBytes <= 0) return empty;

  const entries = await listEpisodes();
  const beforeBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const result: EvictResult = { ...empty, beforeBytes, afterBytes: beforeBytes };
  if (beforeBytes <= limitBytes) return result;

  // 最久未访问的先淘汰
  const ordered = [...entries].sort((a, b) => a.lastAccess - b.lastAccess);
  for (const entry of ordered) {
    if (result.afterBytes <= limitBytes) break;
    const { complete } = await deleteEpisodeByHash(bucket, entry.epHash);
    if (!complete) {
      result.incomplete = true;
      break;
    }
    result.afterBytes -= entry.bytes;
    result.removedEpisodes += 1;
  }
  if (result.afterBytes > limitBytes) result.incomplete = true;
  return result;
}
