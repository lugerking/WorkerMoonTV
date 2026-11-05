import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';

import {
  generateSignature,
  getAuthInfoFromCookie,
  isValidUsername,
  safeStrEqual,
} from '@/lib/auth';

/** 构造带 auth Cookie 的伪 NextRequest */
function fakeRequest(authValue?: string): any {
  return {
    cookies: {
      get: (name: string) =>
        name === 'auth' && authValue !== undefined
          ? { name, value: authValue }
          : undefined,
    },
  };
}

describe('generateSignature（HMAC-SHA256 签发）', () => {
  it('与 Node crypto 的 HMAC-SHA256 结果一致', async () => {
    const sig = await generateSignature('lugerking', 'site-password');
    const expected = createHmac('sha256', 'site-password')
      .update('lugerking')
      .digest('hex');
    expect(sig).toBe(expected);
  });

  it('同一输入结果确定（幂等）', async () => {
    const a = await generateSignature('user', 'secret');
    const b = await generateSignature('user', 'secret');
    expect(a).toBe(b);
  });

  it('不同密钥或不同数据产生不同签名', async () => {
    const a = await generateSignature('user', 'secret');
    const b = await generateSignature('user', 'other-secret');
    const c = await generateSignature('other-user', 'secret');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('签名为 64 位十六进制字符串', async () => {
    const sig = await generateSignature('user', 'secret');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('getAuthInfoFromCookie（服务端 Cookie 解析）', () => {
  it('解析合法的 auth Cookie', () => {
    const authData = {
      username: 'lugerking',
      role: 'owner',
      signature: 'abc123',
      timestamp: 1700000000000,
    };
    const req = fakeRequest(encodeURIComponent(JSON.stringify(authData)));
    const info = getAuthInfoFromCookie(req);
    expect(info).toEqual(authData);
  });

  it('缺少 auth Cookie 时返回 null', () => {
    expect(getAuthInfoFromCookie(fakeRequest(undefined))).toBeNull();
  });

  it('Cookie 内容非法（非 JSON）时返回 null 而不是抛错', () => {
    expect(getAuthInfoFromCookie(fakeRequest('%%%not-json'))).toBeNull();
  });
});

describe('safeStrEqual（恒时比较）', () => {
  it('相同字符串返回 true', async () => {
    expect(await safeStrEqual('password123', 'password123')).toBe(true);
    expect(await safeStrEqual('', '')).toBe(true);
    expect(await safeStrEqual('中文用户名', '中文用户名')).toBe(true);
  });

  it('不同字符串返回 false', async () => {
    expect(await safeStrEqual('password123', 'password124')).toBe(false);
    expect(await safeStrEqual('a', 'b')).toBe(false);
  });

  it('不同长度字符串返回 false（不抛错）', async () => {
    expect(await safeStrEqual('short', 'a-much-longer-string')).toBe(false);
  });
});

describe('isValidUsername（用户名白名单）', () => {
  it.each([
    'lugerking',
    'user_01',
    '小王',
    'a.b-c',
    'Movie2024',
  ])('合法用户名: %s', (name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it.each([
    'a*', // glob 通配符会破坏 Redis key 匹配
    'a?',
    'a[0]',
    'a\\b',
    'a:b', // 冒号干扰 u:<user>:<field> 键结构
    'a b', // 空格
    'a;b',
    '',
    'a'.repeat(65), // 超长
  ])('非法用户名: %j', (name) => {
    expect(isValidUsername(name)).toBe(false);
  });
});
