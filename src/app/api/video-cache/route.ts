import { NextResponse } from 'next/server';

import {
  episodeHash,
  fetchUpstream,
  fromBase64Url,
  getVideoCacheBucket,
  isPlaylistUrl,
  parseSafeUrl,
  playlistKey,
  rewritePlaylist,
  runInBackground,
  segmentKey,
} from '@/lib/video-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单个对象流式转发的上限（64MB）：超过则直接拒绝，避免拖垮 Worker 实例 */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

function corsHeaders(contentType: string): Headers {
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'public, max-age=31536000, s-maxage=31536000');
  return headers;
}

/**
 * 视频缓存代理（公开，供播放器拉取）。
 * - u: 目标绝对地址（base64url）
 * - ep: 所属集的哈希（改写后的播放列表会带上；缺省时按自身地址计算）
 *
 * 播放列表：仅顶级列表参与缓存（命中直接返回，否则回源改写后写入，体积极小）；
 *   多码率 master 的子列表每次实时回源改写，不落盘（否则会与顶级列表争用同一缓存键）。
 * 分片：命中缓存直接返回；未缓存则原样回源透传（不落盘，避免被动占用存储）。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const encoded = searchParams.get('u');
  if (!encoded) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  let targetUrl: string;
  try {
    targetUrl = fromBase64Url(encoded);
  } catch {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 });
  }

  const target = parseSafeUrl(targetUrl);
  if (!target) {
    return NextResponse.json({ error: 'Blocked or invalid url' }, { status: 400 });
  }

  const bucket = getVideoCacheBucket();
  const epParam = searchParams.get('ep');

  /* ---------- 播放列表（含 master 的子列表） ---------- */
  if (isPlaylistUrl(targetUrl)) {
    const epHash = epParam && epParam.length > 0 ? epParam : await episodeHash(targetUrl);
    // 仅顶级播放列表（无 ep 参数）参与缓存；子播放列表若共用键会导致内容互相覆盖，
    // 因此子列表每次实时回源改写，不落盘。
    const isTopLevel = !epParam;

    if (bucket && isTopLevel) {
      const key = playlistKey(epHash);
      const cached = await bucket.get(key);
      if (cached) {
        const text = await cached.text();
        const meta = cached.customMetadata ?? {};
        const prevCount = Number(meta.count ?? '0') || 0;
        runInBackground(
          bucket.put(key, text, {
            customMetadata: {
              src: meta.src ?? '',
              title: meta.title ?? '',
              count: String(prevCount + 1),
              lastAccess: String(Date.now()),
              bytes: meta.bytes ?? '0',
            },
          })
        );
        return new Response(text, {
          status: 200,
          headers: corsHeaders('application/vnd.apple.mpegurl'),
        });
      }
    }

    try {
      const res = await fetchUpstream(target);
      if (!res.ok) {
        return NextResponse.json({ error: res.statusText }, { status: res.status });
      }
      const { text } = rewritePlaylist(await res.text(), targetUrl, epHash);
      if (bucket && isTopLevel) {
        await bucket.put(playlistKey(epHash), text, {
          customMetadata: {
            src: targetUrl.slice(0, 512),
            title: '',
            count: '0',
            lastAccess: String(Date.now()),
            bytes: '0',
          },
        });
      }
      return new Response(text, {
        status: 200,
        headers: corsHeaders('application/vnd.apple.mpegurl'),
      });
    } catch {
      return NextResponse.json({ error: 'Error fetching playlist' }, { status: 500 });
    }
  }

  /* ---------- 分片 ---------- */
  if (bucket && epParam) {
    try {
      const obj = await bucket.get(await segmentKey(epParam, targetUrl));
      if (obj) {
        const bytes = await obj.arrayBuffer();
        const ct = obj.customMetadata?.ct || 'video/mp2t';
        return new Response(bytes, { status: 200, headers: corsHeaders(ct) });
      }
    } catch {
      // 读取失败则回源
    }
  }

  try {
    const res = await fetchUpstream(target);
    if (!res.ok) {
      return NextResponse.json({ error: res.statusText }, { status: res.status });
    }
    const ct = res.headers.get('content-type') || 'video/mp2t';

    // 超大对象直接拒绝：Worker 内存/单次请求能力有限，强行转发会失败且拖慢实例
    // （真实 HLS 的 EXT-X-MAP 初始化段通常只有几 KB，不会命中该分支）
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_STREAM_BYTES) {
      return NextResponse.json(
        { error: `对象过大(${Math.round(declared / 1048576)}MB)，超过转发上限` },
        { status: 413 }
      );
    }

    // 流式转发：视频体量可能远大于 Worker 内存，整块 arrayBuffer 缓冲会 OOM，故逐块读取转发。
    if (res.body) {
      const reader = res.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          } catch (err) {
            controller.error(err);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return new Response(stream, { status: 200, headers: corsHeaders(ct) });
    }

    const buf = await res.arrayBuffer();
    return new Response(buf, { status: 200, headers: corsHeaders(ct) });
  } catch (err) {
    console.error('[video-cache] 分片回源失败:', err);
    return NextResponse.json({ error: 'Error fetching segment' }, { status: 500 });
  }
}
