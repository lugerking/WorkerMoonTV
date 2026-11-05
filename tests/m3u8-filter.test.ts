import { describe, expect, it } from 'vitest';

import { filterM3u8Ads } from '@/lib/m3u8-filter';

/** 构造一个媒体播放列表 */
function buildM3u8(
  segments: Array<{ url: string; dur?: number }>,
  opts: { discontinuities?: number[] } = {}
): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6'];
  const disc = new Set(opts.discontinuities ?? []);
  segments.forEach((s, i) => {
    if (disc.has(i)) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${s.dur ?? 5},`);
    lines.push(s.url);
  });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

const CONTENT_URLS = Array.from({ length: 20 }, (_, i) => `https://cdn.example.com/vod/0000${String(i + 1).padStart(3, '0')}.ts`);
const AD_URLS = ['https://adjump.example.com/video/adjump/time/a1.ts', 'https://adjump.example.com/video/adjump/time/a2.ts', 'https://adjump.example.com/video/adjump/time/a3.ts'];

describe('filterM3u8Ads 基本守卫', () => {
  it('master 播放列表（含 #EXT-X-STREAM-INF）原样返回', () => {
    const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=2000000', 'https://cdn.example.com/index.m3u8'].join('\n');
    expect(filterM3u8Ads(master)).toBe(master);
  });

  it('非媒体播放列表（无 #EXTINF）原样返回', () => {
    const html = '<html>anti-bot page</html>';
    expect(filterM3u8Ads(html)).toBe(html);
  });

  it('分片数不足 10 段时不做过滤', () => {
    const segs = [...CONTENT_URLS.slice(0, 8), ...AD_URLS].map((url) => ({ url }));
    const m3u8 = buildM3u8(segs, { discontinuities: [8] });
    expect(filterM3u8Ads(m3u8)).toBe(m3u8);
  });

  it('无广告的干净列表保持不变', () => {
    const segs = CONTENT_URLS.slice(0, 12).map((url) => ({ url }));
    const m3u8 = buildM3u8(segs);
    expect(filterM3u8Ads(m3u8)).toBe(m3u8);
  });
});

describe('方法 1：目录指纹法（独立目录广告）', () => {
  it('删除少数派广告目录的全部分片，保留正片', () => {
    // 正片 20 段目录 A + 广告 3 段目录 B（DISCONTINUITY 包裹）
    const segs = [
      ...CONTENT_URLS.map((url) => ({ url })),
      ...AD_URLS.map((url) => ({ url })),
    ];
    const m3u8 = buildM3u8(segs, { discontinuities: [20] });
    const out = filterM3u8Ads(m3u8);

    // 广告分片及其伴随行全部移除
    AD_URLS.forEach((u) => expect(out).not.toContain(u));
    expect(out).not.toContain('adjump');
    // 正片分片全部保留
    CONTENT_URLS.forEach((u) => expect(out).toContain(u));
  });
});

describe('方法 2：DISCONTINUITY 分块时长法（短块夹插广告）', () => {
  it('删除短小广告块，保留长正片块', () => {
    // 全部同目录：正片 30 段 + 广告 3 段（每段 4s，共 12s < 60s）
    const urls = [
      ...CONTENT_URLS,
      ...AD_URLS.map((u) => u.replace('https://adjump.example.com/video/adjump/time/', 'https://cdn.example.com/vod/')),
    ];
    const segs = urls.map((url) => ({ url, dur: 5 }));
    // 广告块位于中间：第 20 段后插入 DISCONTINUITY 形成独立短块
    const m3u8 = buildM3u8(segs, { discontinuities: [20, 23] });
    const out = filterM3u8Ads(m3u8);

    // 被切出的 3 段短块（20,21,22）判定为广告
    expect(out).not.toContain(urls[20]);
    expect(out).not.toContain(urls[21]);
    expect(out).not.toContain(urls[22]);
    // 其余正片保留
    urls.filter((_, i) => i < 20 || i >= 23).forEach((u) => expect(out).toContain(u));
  });

  it('广告占比过高（>15%）时放弃过滤，宁漏勿删', () => {
    // 大量短块构成天然短块源：广告块时长占比超 15%
    const segs: Array<{ url: string; dur?: number }> = [];
    const urls: string[] = [];
    // 10 个 20 段正片块 + 5 个 2 段广告块（同为短块，占比过高）
    for (let b = 0; b < 10; b++) {
      for (let k = 0; k < 20; k++) {
        urls.push(`https://cdn.example.com/vod/c${b}_${k}.ts`);
      }
    }
    for (let b = 0; b < 5; b++) {
      for (let k = 0; k < 2; k++) {
        urls.push(`https://cdn.example.com/vod/adx${b}_${k}.ts`);
      }
    }
    urls.forEach((url) => segs.push({ url, dur: 5 }));
    // 全部以 DISCONTINUITY 切成短块：模拟整集 2 段一块的源
    const m3u8 = buildM3u8(segs, { discontinuities: urls.map((_, i) => i).filter((i) => i % 2 === 0) });
    const out = filterM3u8Ads(m3u8);
    // 该源天然短块切片，不应误删任何内容
    urls.forEach((u) => expect(out).toContain(u));
  });
});

describe('方法 3：序号离群检测（序号跳变广告）', () => {
  it('删除序号远离正片值域的广告分片', () => {
    const urls: string[] = [];
    // 正片：序号 1000~1031 连续递增
    for (let i = 1000; i <= 1031; i++) {
      urls.push(`https://cdn.example.com/lz/${String(i).padStart(6, '0')}.ts`);
    }
    // 广告：序号来自另一个池，远离正片值域
    urls.push('https://cdn.example.com/lz/987654321.ts');
    urls.push('https://cdn.example.com/lz/987654322.ts');

    const segs = urls.map((url) => ({ url }));
    const m3u8 = buildM3u8(segs, { discontinuities: [32] });
    const out = filterM3u8Ads(m3u8);

    expect(out).not.toContain('987654321.ts');
    expect(out).not.toContain('987654322.ts');
    urls.slice(0, 32).forEach((u) => expect(out).toContain(u));
  });
});

describe('方法 4：均匀分块源的短游程检测（dyttzy 式）', () => {
  it('删除「和为众数整数倍」的广告游程，保留被挤短的正片块', () => {
    const urls: string[] = [];
    // 众数块 = 5 段；[3,2] 游程的和恰为 5 的倍数 → 判定为广告
    const pattern = [5, 5, 3, 2, 5, 5, 5, 5, 5]; // 游程 [3,2] 在中间（非边缘）
    pattern.forEach((n, bi) => {
      for (let k = 0; k < n; k++) {
        // 全哈希文件名（尾字符为字母，避免触发序号法）
        urls.push(`https://cdn.example.com/dytt/hash${bi}_${k}f.ts`);
      }
    });
    const segs = urls.map((url) => ({ url, dur: 4 }));
    // 按块切 DISCONTINUITY
    const disc: number[] = [];
    let acc = 0;
    for (let bi = 0; bi < pattern.length - 1; bi++) {
      acc += pattern[bi];
      disc.push(acc);
    }
    const m3u8 = buildM3u8(segs, { discontinuities: disc });
    const out = filterM3u8Ads(m3u8);

    // 广告游程（第 2、3 块共 5 段）被删除
    const adStart = pattern[0] + pattern[1];
    urls.slice(adStart, adStart + 5).forEach((u) => expect(out).not.toContain(u));
    // 其余正片全部保留
    urls.filter((_, i) => i < adStart || i >= adStart + 5).forEach((u) => expect(out).toContain(u));
  });
});

describe('重建逻辑', () => {
  it('删除广告分片时同步移除其伴随行（#EXTINF）', () => {
    const segs = [...CONTENT_URLS.map((url) => ({ url })), ...AD_URLS.map((url) => ({ url }))];
    const m3u8 = buildM3u8(segs, { discontinuities: [20] });
    const out = filterM3u8Ads(m3u8);
    // 广告 EXTINF 不应残留为空伴随行
    expect(out).not.toContain('adjump');
    // 文件头保留
    expect(out.startsWith('#EXTM3U')).toBe(true);
    expect(out).toContain('#EXT-X-ENDLIST');
  });
});
