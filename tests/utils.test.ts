import { beforeEach, describe, expect, it } from 'vitest';

import {
  cleanHtmlTags,
  encodeBase64Url,
  processImageUrl,
} from '@/lib/utils';

describe('encodeBase64Url', () => {
  it('ASCII 字符串编码正确', () => {
    expect(encodeBase64Url('hello')).toBe('aGVsbG8');
  });

  it('结果不含 + / = 字符（URL 安全）', () => {
    const out = encodeBase64Url('a+b/c=');
    expect(out).not.toMatch(/[+/=]/);
  });

  it('中文等 UTF-8 字符可无损往返', () => {
    const input = '斗破苍穹年番 第 164 集';
    const encoded = encodeBase64Url(input);
    // 手动解码验证：base64url → base64 → utf8
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toBe(input);
  });
});

describe('cleanHtmlTags', () => {
  it('移除 HTML 标签并以换行分隔', () => {
    expect(cleanHtmlTags('<p>你好</p><p>世界</p>')).toBe('你好\n世界');
  });

  it('合并连续空行与空白', () => {
    expect(cleanHtmlTags('a<br><br/>b')).toBe('a\nb');
    expect(cleanHtmlTags('a<p>   b')).toBe('a\n b');
  });

  it('处理 &nbsp; 实体', () => {
    expect(cleanHtmlTags('a&nbsp;b')).toBe('a b');
  });

  it('空输入返回空字符串', () => {
    expect(cleanHtmlTags('')).toBe('');
    expect(cleanHtmlTags('<p></p>')).toBe('');
  });
});

describe('processImageUrl', () => {
  beforeEach(() => {
    localStorage.clear();
    (window as any).RUNTIME_CONFIG = undefined;
  });

  it('未配置代理时返回原图地址', () => {
    expect(processImageUrl('https://img.example.com/x.jpg')).toBe(
      'https://img.example.com/x.jpg'
    );
    expect(processImageUrl('')).toBe('');
  });

  it('配置内置代理时使用 base64url 编码目标地址', () => {
    localStorage.setItem('imageProxyUrl', '/api/image-proxy?url=');
    const out = processImageUrl('https://img.example.com/x.jpg', '影片名');
    expect(out.startsWith('/api/image-proxy?u=')).toBe(true);
    expect(out).toContain('&t=');
    // 代理 URL 中不出现可读的第三方域名
    expect(out).not.toContain('img.example.com');
    expect(out).not.toContain('影片名');
  });

  it('配置自定义前缀代理时直接拼接编码后的地址', () => {
    localStorage.setItem('imageProxyUrl', 'https://p.example.com/img?u=');
    const out = processImageUrl('https://img.example.com/x.jpg');
    expect(out.startsWith('https://p.example.com/img?u=')).toBe(true);
  });

  it('本地关闭图片代理开关时不走代理', () => {
    localStorage.setItem('enableImageProxy', 'false');
    localStorage.setItem('imageProxyUrl', '/api/image-proxy?url=');
    expect(processImageUrl('https://img.example.com/x.jpg')).toBe(
      'https://img.example.com/x.jpg'
    );
  });
});
