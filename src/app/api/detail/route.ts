import { NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { getDetailFromApi, resolveShareUrl } from '@/lib/downstream';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const sourceCode = searchParams.get('source');

  if (!id || !sourceCode) {
    return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
  }

  if (!/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID格式' }, { status: 400 });
  }

  try {
    const apiSites = await getAvailableApiSites();
    const apiSite = apiSites.find((site) => site.key === sourceCode);

    if (!apiSite) {
      return NextResponse.json({ error: '无效的API来源' }, { status: 400 });
    }

    const result = await getDetailFromApi(apiSite, id);
    // 解析 /share/ 防盗链包装地址为真实 m3u8（如 lz/dytt 系列资源站）。
    // 长剧可能有 200+ 集，分批并发解析，避免瞬时打满上游。
    if (result.episodes?.length) {
      const resolved: string[] = [];
      const BATCH = 10;
      for (let i = 0; i < result.episodes.length; i += BATCH) {
        const chunk = result.episodes.slice(i, i + BATCH);
        const done = await Promise.all(chunk.map((ep) => resolveShareUrl(ep)));
        resolved.push(...done);
      }
      result.episodes = resolved;
    }
    const cacheTime = await getCacheTime();

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
        'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
