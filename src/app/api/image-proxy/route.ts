import { NextResponse } from 'next/server';

import { cacheKeyFor, getImageCacheBucket, runInBackground } from '@/lib/image-cache';

export const runtime = 'nodejs';

// 单张图片超过该大小则不写入 R2（避免大对象占用内存/存储）
const MAX_CACHEABLE_SIZE = 5 * 1024 * 1024;
// 超过该大小直接透传，不缓冲到内存
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

// 上游回源并发闸门：限制同时向上游图床（豆瓣等）发起的请求数，其余排队。
// 目的：避免首页批量海报并发回源触发上游限流导致部分图片加载失败。
const MAX_UPSTREAM_CONCURRENCY = 6;
let upstreamActive = 0;
const upstreamWaiters: Array<() => void> = [];

async function withUpstreamSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (upstreamActive >= MAX_UPSTREAM_CONCURRENCY) {
    await new Promise<void>((resolve) => upstreamWaiters.push(resolve));
  }
  upstreamActive++;
  try {
    return await fn();
  } finally {
    upstreamActive--;
    const next = upstreamWaiters.shift();
    if (next) next();
  }
}

function buildHeaders(contentType: string): Headers {
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000'); // 缓存半年
  headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');
  headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=15720000');
  headers.set('Access-Control-Allow-Origin', '*');
  return headers;
}

// 拦截内网/本地主机，降低开放代理被滥用于 SSRF 的风险
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local')
  ) {
    return true;
  }

  // IPv4 字面量
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const octets = ipv4.slice(1);
    // 含前导零的段可能被解析器按八进制解释（如 0177.0.0.1 → 127.0.0.1），直接拒绝
    if (octets.some((s) => s.length > 1 && s.startsWith('0'))) return true;
    const octetNums = octets.map(Number);
    if (octetNums.some((n) => n > 255)) return false; // 非法地址交给 fetch 失败处理
    const [a, b] = octetNums;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // 链路本地 / 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true; // 私有网段
    if (a === 192 && b === 168) return true;
  }

  // 非点分十进制的整数 IP 变体（十进制 2130706433 / 十六进制 0x7f000001），
  // 正常图床不会以这种形式出现，直接拒绝以封堵 127.0.0.1 等价写法
  if (/^\d{8,}$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) {
    return true;
  }

  // IPv6 回环/唯一本地/链路本地
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) {
    return true;
  }

  return false;
}

// 图片代理：让浏览器经同源代理加载第三方海报，绕开防盗链/混合内容/地域封锁
// 并可选使用 R2 作为缓存层，命中后直接返回，省去回源
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // 支持 base64url 编码的 u= 参数：前端用它避免 URL 中出现可读第三方域名，
  // 从而躲过广告/追踪拦截器对 `url=https://...` 类参数的拦截。
  const encoded = searchParams.get('u');
  let imageUrl: string | null = searchParams.get('url');
  if (encoded) {
    try {
      imageUrl = Buffer.from(encoded, 'base64url').toString('utf-8');
    } catch {
      imageUrl = null;
    }
  }

  // 可选的片名（base64url 编码）：记录到缓存对象的元数据中，便于在 R2 里辨识该图属于哪部影片
  const encodedTitle = searchParams.get('t');
  let imageTitle = '';
  if (encodedTitle) {
    try {
      imageTitle = Buffer.from(encodedTitle, 'base64url')
        .toString('utf-8')
        .slice(0, 200);
    } catch {
      imageTitle = '';
    }
  }

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(imageUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid image URL' }, { status: 400 });
  }

  // 仅允许 http/https，拦截内网主机，避免开放代理被滥用（SSRF）
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return NextResponse.json({ error: 'Unsupported protocol' }, { status: 400 });
  }
  if (isBlockedHost(target.hostname)) {
    return NextResponse.json({ error: 'Blocked host' }, { status: 403 });
  }

  const bucket = getImageCacheBucket();
  const key = bucket ? await cacheKeyFor(imageUrl) : '';

  // 1) 命中 R2 缓存：直接返回，并异步累加访问频次
  if (bucket) {
    try {
      const cached = await bucket.get(key);
      if (cached) {
        const bytes = await cached.arrayBuffer();
        const contentType = cached.customMetadata?.contentType || 'image/jpeg';
        const headers = buildHeaders(contentType);
        headers.set('X-Image-Cache', 'HIT');

        const prevCount = Number(cached.customMetadata?.count ?? '1') || 1;
        runInBackground(
          bucket.put(key, bytes, {
            customMetadata: {
              contentType,
              url: imageUrl.slice(0, 512),
              title: imageTitle || cached.customMetadata?.title || '',
              count: String(prevCount + 1),
              lastAccess: String(Date.now()),
            },
          })
        );

        return new Response(bytes, { status: 200, headers });
      }
    } catch {
      // 缓存异常不应影响用户：降级为回源
    }
  }

  // 防盗链策略：
  // - 豆瓣图床对「无 Referer」请求返回 418，需带任意非空 Referer；
  // - 影视源图床多校验「同源 Referer」，带自身域名 Referer 更易通过。
  const host = target.hostname.toLowerCase();
  const referer = host.includes('douban')
    ? 'https://movie.douban.com/'
    : `${target.origin}/`;

  const upstreamHeaders = {
    Referer: referer,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
  };

  try {
    // 并发闸门：首页一次渲染几十张海报时，若全部并发回源，会触发豆瓣限流
    // （部分请求 429/失败 → 前端裂图）。限制同时回源数并将超出部分排队。
    const imageResponse = await withUpstreamSlot(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        let res = await fetch(target.toString(), {
          headers: upstreamHeaders,
          signal: controller.signal,
        });
        // 限流/上游瞬时错误：短退避后重试一次
        if (!res.ok && (res.status === 429 || res.status >= 500)) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          res = await fetch(target.toString(), {
            headers: upstreamHeaders,
            signal: controller.signal,
          });
        }
        // 豆瓣图床对数据中心 IP 常返回 403/429：改走公共镜像 weserv 回源兜底，
        // 避免机房 IP 被封导致整批海报裂图。镜像结果同样会写入磁盘缓存。
        if (
          !res.ok &&
          (res.status === 403 || res.status === 429 || res.status >= 500) &&
          host.includes('douban')
        ) {
          try {
            const mirror = await fetch(
              `https://images.weserv.pl/?url=${encodeURIComponent(target.toString())}`,
              { headers: upstreamHeaders, signal: controller.signal }
            );
            if (mirror.ok) res = mirror;
          } catch {
            // 镜像失败时沿用上游结果
          }
        }
        return res;
      } finally {
        clearTimeout(timeoutId);
      }
    }).then((res) => {
      // 上游 302 跳转后的最终地址仍需校验，防止借重定向绕过内网封禁
      if (res && res.ok && res.url && isBlockedHost(new URL(res.url).hostname)) {
        return null;
      }
      return res;
    });

    if (!imageResponse) {
      return NextResponse.json({ error: 'Blocked host' }, { status: 403 });
    }

    if (!imageResponse.ok) {
      return NextResponse.json(
        { error: imageResponse.statusText },
        { status: imageResponse.status }
      );
    }

    const contentType = imageResponse.headers.get('content-type');
    // 仅回传图片类型，避免开放代理被用于回显内网 HTML/JSON（进一步降低 SSRF 危害）
    if (contentType && !contentType.toLowerCase().startsWith('image/')) {
      return NextResponse.json({ error: 'Not an image' }, { status: 400 });
    }

    if (!imageResponse.body) {
      return NextResponse.json(
        { error: 'Image response has no body' },
        { status: 500 }
      );
    }

    const resolvedType = contentType || 'image/jpeg';
    const headers = buildHeaders(resolvedType);
    headers.set('X-Image-Cache', bucket ? 'MISS' : 'BYPASS');

    // 超大响应直接透传，不缓冲进内存
    const declaredSize = Number(imageResponse.headers.get('content-length') || 0);
    if (declaredSize > MAX_BUFFER_SIZE) {
      return new Response(imageResponse.body, { status: 200, headers });
    }

    const bytes = await imageResponse.arrayBuffer();

    // 2) 回源成功后写入 R2
    if (bucket && bytes.byteLength > 0 && bytes.byteLength <= MAX_CACHEABLE_SIZE) {
      runInBackground(
        bucket.put(key, bytes, {
          customMetadata: {
            contentType: resolvedType,
            url: imageUrl.slice(0, 512),
            title: imageTitle,
            count: '1',
            lastAccess: String(Date.now()),
          },
        })
      );
    }

    return new Response(bytes, { status: 200, headers });
  } catch (error) {
    return NextResponse.json(
      { error: 'Error fetching image' },
      { status: 500 }
    );
  }
}
