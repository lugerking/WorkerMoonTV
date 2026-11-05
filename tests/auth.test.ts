import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';

import {
  generateSignature,
  getAuthInfoFromCookie,
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
