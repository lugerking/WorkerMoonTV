/**
 * transit-api —— 资源站 API 反向代理 Worker
 *
 * 路由形态：GET/POST /?u=<encodeURIComponent(完整上游URL)>
 * - 仅允许目标路径含 api.php/provide/vod 的苹果 CMS 采集接口
 * - 目标 host 必须以白名单后缀结尾，否则 403
 * - 响应透传 Content-Type 与 body，并附加 CORS 头
 */

const WORKER_NAME = 'transit-api';

// 资源站域名白名单后缀（按需增补）
const ALLOWED_HOST_SUFFIXES = [
  'dyttzyapi.com',
  'ffzyapi.com',
  'bfzyapi.com',
  'lzcaiji.com',
  'tykope.com',
  'dbtv.cn',
  'slkxw.com',
  'wolongzyw.com',
  'cjhwba.com',
  'yinghuaapi.com',
  'feifanzy.com',
  'maozy.com',
  'zycaiji.com',
  'kuaichezy.net',
];

// 仅允许苹果 CMS vod 采集接口
const REQUIRED_PATH_SEGMENT = 'api.php/provide/vod';

const FORWARD_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function isAllowedTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!url.pathname.includes(REQUIRED_PATH_SEGMENT)) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const requestUrl = new URL(request.url);
    const target = requestUrl.searchParams.get('u');

    // 健康检查：GET /（无 u 参数）
    if (!target) {
      return jsonResponse({
        name: WORKER_NAME,
        time: new Date().toISOString(),
      });
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    // 白名单校验：路径含 api.php/provide/vod 且 host 在白名单内
    if (!isAllowedTarget(target)) {
      return jsonResponse({ error: 'target not allowed' }, 403);
    }

    const targetUrl = new URL(target);
    // 透传目标 URL 自身的查询串（wd/ac/ids 等已在 u 中编码携带）
    const headers = {
      'User-Agent': FORWARD_UA,
      Referer: `${targetUrl.origin}/`,
      Accept: 'application/json, text/plain, */*',
    };

    let body;
    if (request.method === 'POST') {
      const contentType = request.headers.get('content-type');
      if (contentType) headers['Content-Type'] = contentType;
      body = await request.text();
    }

    const upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body,
      redirect: 'follow',
      cf: { cacheTtl: 300, cacheEverything: false },
    });

    const responseHeaders = new Headers();
    const contentType = upstream.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  },
};
