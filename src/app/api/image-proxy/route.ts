import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

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
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return false; // 非法地址交给 fetch 失败处理
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // 链路本地 / 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true; // 私有网段
    if (a === 192 && b === 168) return true;
  }

  // IPv6 回环/唯一本地/链路本地
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) {
    return true;
  }

  return false;
}

// 图片代理：让浏览器经同源代理加载第三方海报，绕开防盗链/混合内容/地域封锁
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

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

  // 防盗链策略：
  // - 豆瓣图床对「无 Referer」请求返回 418，需带任意非空 Referer；
  // - 影视源图床多校验「同源 Referer」，带自身域名 Referer 更易通过。
  const host = target.hostname.toLowerCase();
  const referer = host.includes('douban')
    ? 'https://movie.douban.com/'
    : `${target.origin}/`;

  try {
    const imageResponse = await fetch(target.toString(), {
      headers: {
        Referer: referer,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
      },
    });

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

    const headers = new Headers();
    if (contentType) {
      headers.set('Content-Type', contentType);
    }
    headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000'); // 缓存半年
    headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');
    headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=15720000');
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(imageResponse.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Error fetching image' },
      { status: 500 }
    );
  }
}
