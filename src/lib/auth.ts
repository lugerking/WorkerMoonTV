import { NextRequest } from 'next/server';

// 从cookie获取认证信息 (服务端使用)
export function getAuthInfoFromCookie(request: NextRequest): {
  password?: string;
  username?: string;
  signature?: string;
  timestamp?: number;
} | null {
  const authCookie = request.cookies.get('auth');

  if (!authCookie) {
    return null;
  }

  try {
    const decoded = decodeURIComponent(authCookie.value);
    const authData = JSON.parse(decoded);
    return authData;
  } catch {
    return null;
  }
}

// 从cookie获取认证信息 (客户端使用)
export function getAuthInfoFromBrowserCookie(): {
  password?: string;
  username?: string;
  signature?: string;
  timestamp?: number;
  role?: 'owner' | 'admin' | 'user';
} | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    // 解析 document.cookie
    const cookies = document.cookie.split(';').reduce((acc, cookie) => {
      const trimmed = cookie.trim();
      const firstEqualIndex = trimmed.indexOf('=');

      if (firstEqualIndex > 0) {
        const key = trimmed.substring(0, firstEqualIndex);
        const value = trimmed.substring(firstEqualIndex + 1);
        if (key && value) {
          acc[key] = value;
        }
      }

      return acc;
    }, {} as Record<string, string>);

    const authCookie = cookies['auth'];
    if (!authCookie) {
      return null;
    }

    // 处理可能的双重编码
    let decoded = decodeURIComponent(authCookie);

    // 如果解码后仍然包含 %，说明是双重编码，需要再次解码
    if (decoded.includes('%')) {
      decoded = decodeURIComponent(decoded);
    }

    const authData = JSON.parse(decoded);
    return authData;
  } catch {
    return null;
  }
}

/**
 * 生成 HMAC-SHA256 签名（十六进制字符串）
 *
 * 用于登录/注册时签发 Cookie 的 signature 字段，密钥为 PASSWORD。
 * 服务端签发（login/register 路由）与中间件验签（middleware.ts）使用同一算法。
 */
export async function generateSignature(
  data: string,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 恒时字符串比较（用于密码/密钥校验，避免时序侧信道）。
 * 先把两侧都 SHA-256 到固定 32 字节再逐字节异或比较，
 * 既消除长度信息泄漏，也兼容 Node 与 Workers（不依赖平台专有的
 * crypto.subtle.timingSafeEqual / node:crypto）。
 */
export async function safeStrEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) {
    diff |= va[i] ^ vb[i];
  }
  return diff === 0;
}

/**
 * 用户名白名单校验：字母/数字/下划线/中文/点/连字符，长度 1-64。
 * 禁止 `* ? [ ] \\ :` 等字符——这些字符进入 Redis key 后会破坏
 * `u:<user>:pr:*` 这类 glob 模式匹配，导致跨用户数据串读/误删。
 */
export function isValidUsername(username: string): boolean {
  return /^[\w\u4e00-\u9fa5.-]{1,64}$/.test(username);
}
