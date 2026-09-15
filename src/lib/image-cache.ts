/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * R2 图片缓存的公共操作：绑定获取、缓存键、列举、频率打分、清理、统计。
 */

/** 频率评分的时间半衰期（小时）：越久未访问，历史频次衰减越多 */
const SCORE_HALF_LIFE_HOURS = 24;
/** 每轮删除的对象数：Worker 单次调用的子请求数有限，必须分批 */
const DELETE_BATCH = 40;
/** 单次清理最多执行的轮数，避免异常情况下死循环 */
const MAX_ROUNDS = 20;

export interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: ArrayBuffer, options?: any): Promise<any>;
  delete(key: string): Promise<void>;
  list(options?: any): Promise<{
    objects: Array<{ key: string; size?: number; customMetadata?: Record<string, string> }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

// 说明：OpenNext Cloudflare 仅把「字符串型」变量注入 process.env，
// R2 绑定是对象，需通过 Cloudflare 上下文的全局符号获取（此处避免直接 import ESM 包）。
export function getCloudflareContext(): any {
  try {
    return (globalThis as any)[Symbol.for('__cloudflare-context__')];
  } catch {
    return null;
  }
}

/** 未绑定 IMAGE_CACHE 时返回 null，调用方自动降级 */
export function getImageCacheBucket(): R2BucketLike | null {
  try {
    const ctx = getCloudflareContext();
    const bucket = ctx?.env?.IMAGE_CACHE;
    if (bucket && typeof bucket.get === 'function') {
      return bucket as R2BucketLike;
    }
  } catch {
    // ignore
  }
  return null;
}

/** 后台任务：有 waitUntil 时延长生命周期，避免阻塞响应返回 */
export function runInBackground(promise: Promise<unknown>) {
  // 记录失败原因，避免后台写入失败被静默吞掉
  const safe = promise.catch((err) => {
    console.error('[img-cache] background task failed:', err);
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
  // 无 waitUntil 时尽力而为（结果不影响本次响应）
}

/** 以 URL 的 SHA-256 作为缓存键，避免原始 URL 中的特殊字符/长度问题 */
export async function cacheKeyFor(imageUrl: string): Promise<string> {
  const data = new TextEncoder().encode(imageUrl);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `img/${hex}`;
}

/**
 * 分页取回全部对象（含自定义元数据）。
 * 注意：带 include: ['customMetadata'] 时单次 list 返回条数明显少于 limit（实测约 297 条），
 * 必须按 truncated/cursor 翻页，否则统计到的数量偏少、清理判断会失效。
 */
export async function listAllObjects(bucket: R2BucketLike) {
  const all: Array<{ key: string; size?: number; customMetadata?: Record<string, string> }> = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(
      cursor
        ? { limit: 1000, include: ['customMetadata'], cursor }
        : { limit: 1000, include: ['customMetadata'] }
    );
    all.push(...(page.objects ?? []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return all;
}

/** 打分：访问次数为主，按未访问时长做指数衰减 → 综合体现「近期访问最频繁」 */
export function accessScore(
  meta: Record<string, string> | undefined,
  now: number
): number {
  const count = Number(meta?.count ?? 1) || 1;
  const last = Number(meta?.lastAccess ?? 0) || 0;
  const hours = Math.max(0, (now - last) / 3600000);
  return count * Math.pow(0.5, hours / SCORE_HALF_LIFE_HOURS);
}

export interface ImageCacheStats {
  available: boolean;
  total: number;
  sizeBytes: number;
}

/** 统计当前缓存的对象数与总占用 */
export async function getImageCacheStats(): Promise<ImageCacheStats> {
  const bucket = getImageCacheBucket();
  if (!bucket) return { available: false, total: 0, sizeBytes: 0 };
  try {
    const objects = await listAllObjects(bucket);
    return {
      available: true,
      total: objects.length,
      sizeBytes: objects.reduce((sum, o) => sum + (o.size || 0), 0),
    };
  } catch (err) {
    console.error('[img-cache] stats failed:', err);
    return { available: true, total: -1, sizeBytes: 0 };
  }
}

export interface CleanupResult {
  available: boolean;
  /** limit <= 0 时为 true，表示未限制、未执行清理 */
  unlimited: boolean;
  limit: number;
  /** 清理前数量 */
  before: number;
  /** 清理后数量（-1 表示统计失败） */
  after: number;
  deleted: number;
  /** 是否因达到轮次上限而未清理干净 */
  incomplete: boolean;
}

/**
 * 将缓存数量收敛到 limit 张：按「近期访问频率」打分，淘汰得分最低的。
 * limit <= 0 表示不限制，直接跳过。
 */
export async function cleanupImageCache(limit: number): Promise<CleanupResult> {
  const bucket = getImageCacheBucket();
  if (!bucket) {
    return { available: false, unlimited: false, limit, before: 0, after: 0, deleted: 0, incomplete: false };
  }

  const result: CleanupResult = {
    available: true,
    unlimited: !limit || limit <= 0,
    limit,
    before: 0,
    after: 0,
    deleted: 0,
    incomplete: false,
  };
  if (result.unlimited) {
    const stats = await getImageCacheStats();
    result.before = stats.total;
    result.after = stats.total;
    return result;
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let victims: string[] = [];
    try {
      const objects = await listAllObjects(bucket);
      if (round === 0) result.before = objects.length;
      if (objects.length <= limit) break;

      const now = Date.now();
      const ranked = objects
        .map((o) => ({ key: o.key, score: accessScore(o.customMetadata, now) }))
        .sort((a, b) => b.score - a.score);

      victims = ranked.slice(limit).map((r) => r.key);
      const batch = victims.slice(0, DELETE_BATCH);
      if (batch.length === 0) break;

      await Promise.all(batch.map((key) => bucket.delete(key)));
      result.deleted += batch.length;
    } catch (err) {
      // 子请求数超限等情况：保留已完成的删除量，交由下次执行继续收敛
      console.error('[img-cache] cleanup round failed:', err);
      result.incomplete = victims.length > DELETE_BATCH;
      break;
    }
  }

  const stats = await getImageCacheStats();
  result.after = stats.total;
  if (result.after >= 0 && result.after > limit) result.incomplete = true;
  return result;
}
