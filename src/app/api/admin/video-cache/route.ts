/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { DEFAULT_VIDEO_CACHE_LIMIT_GB, getConfig } from '@/lib/config';
import { isAdmin } from '@/lib/users';
import {
  cacheSegmentBatch,
  deleteEpisode,
  evictVideoCache,
  fromBase64Url,
  getEpisodeStatus,
  getVideoCacheStats,
  listEpisodes,
} from '@/lib/video-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireAdmin(
  request: NextRequest
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  const username = authInfo.username;
  if (username !== process.env.USERNAME && !(await isAdmin(username))) {
    return {
      ok: false,
      response: NextResponse.json({ error: '权限不足' }, { status: 401 }),
    };
  }
  return { ok: true };
}

async function readLimitGB(): Promise<number> {
  try {
    const config = await getConfig();
    const configured = Number(config?.SiteConfig?.VideoCacheLimitGB);
    return Number.isFinite(configured)
      ? configured
      : DEFAULT_VIDEO_CACHE_LIMIT_GB;
  } catch (err) {
    console.error('读取视频缓存上限失败，使用默认值:', err);
    return DEFAULT_VIDEO_CACHE_LIMIT_GB;
  }
}

/** 查询统计与列表；带 u 参数时查询某一集的缓存状态 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (!auth.ok) return auth.response;

    const u = request.nextUrl.searchParams.get('u');
    if (u) {
      let episodeUrl: string;
      try {
        episodeUrl = fromBase64Url(u);
      } catch {
        return NextResponse.json({ error: 'Invalid url' }, { status: 400 });
      }
      const status = await getEpisodeStatus(episodeUrl);
      return NextResponse.json(status, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const [stats, episodes, limitGB] = await Promise.all([
      getVideoCacheStats(),
      listEpisodes(),
      readLimitGB(),
    ]);
    return NextResponse.json(
      { ...stats, limitGB, episodes },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('获取视频缓存信息失败:', error);
    return NextResponse.json(
      { error: '获取视频缓存信息失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}

/**
 * 管理操作（仅管理员）：
 * - action=cache  缓存一批分片（body: { url, title?, offset? }），前端按 nextOffset 循环调用直到 done
 * - action=delete 删除某集缓存（body: { url }）
 * - action=evict  按容量上限淘汰最久未访问的整集
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (!auth.ok) return auth.response;

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // 允许无 body
    }
    const action = body?.action || 'cache';

    if (action === 'delete') {
      if (!body?.url) {
        return NextResponse.json({ error: '缺少 url' }, { status: 400 });
      }
      const result = await deleteEpisode(body.url);
      return NextResponse.json(
        { ok: true, ...result },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (action === 'deleteBatch') {
      const urls: unknown = body?.urls;
      if (!Array.isArray(urls) || urls.length === 0) {
        return NextResponse.json({ error: '缺少 urls' }, { status: 400 });
      }
      let deleted = 0;
      let incomplete = 0;
      for (const u of urls) {
        if (typeof u !== 'string' || !u) continue;
        try {
          const r = await deleteEpisode(u);
          deleted++;
          if (!r.complete) incomplete++;
        } catch (err) {
          console.error('[video-cache] 批量删除失败:', u, err);
          incomplete++;
        }
      }
      return NextResponse.json(
        { ok: true, requested: urls.length, deleted, incomplete },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (action === 'evict') {
      const limitGB = await readLimitGB();
      const result = await evictVideoCache(limitGB * 1024 * 1024 * 1024);
      return NextResponse.json(
        { ok: true, ...result },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (action === 'cache') {
      if (!body?.url) {
        return NextResponse.json({ error: '缺少 url' }, { status: 400 });
      }
      const offset = Number.isFinite(Number(body?.offset))
        ? Math.max(0, Math.floor(Number(body.offset)))
        : 0;
      const result = await cacheSegmentBatch(body.url, offset, body?.title, {
        source: typeof body?.source === 'string' ? body.source : undefined,
        vid: typeof body?.vid === 'string' ? body.vid : undefined,
        epIndex: Number.isFinite(Number(body?.epIndex))
          ? Number(body.epIndex)
          : undefined,
        epTotal: Number.isFinite(Number(body?.epTotal))
          ? Number(body.epTotal)
          : undefined,
      });
      // 整集缓存完成后做一次容量检查（上限为 0 时表示不限制）
      if (result.done) {
        const limitGB = await readLimitGB();
        if (limitGB > 0) {
          await evictVideoCache(limitGB * 1024 * 1024 * 1024);
        }
      }
      return NextResponse.json(
        { ok: true, ...result },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json({ error: '未知操作' }, { status: 400 });
  } catch (error) {
    console.error('视频缓存操作失败:', error);
    return NextResponse.json(
      { error: '视频缓存操作失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
