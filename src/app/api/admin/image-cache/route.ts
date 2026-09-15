/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { DEFAULT_IMAGE_CACHE_LIMIT, getConfig } from '@/lib/config';
import { cleanupImageCache, getImageCacheStats } from '@/lib/image-cache';
import { isAdmin } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 读取当前图片缓存统计与生效的上限 */
export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const username = authInfo.username;
    if (username !== process.env.USERNAME && !(await isAdmin(username))) {
      return NextResponse.json({ error: '权限不足' }, { status: 401 });
    }

    let limit = DEFAULT_IMAGE_CACHE_LIMIT;
    try {
      const config = await getConfig();
      const configured = Number(config?.SiteConfig?.ImageCacheLimit);
      limit = Number.isFinite(configured) ? configured : DEFAULT_IMAGE_CACHE_LIMIT;
    } catch (err) {
      console.error('读取图片缓存上限失败，使用默认值:', err);
    }

    const stats = await getImageCacheStats();
    return NextResponse.json(
      { ...stats, limit },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('获取图片缓存统计失败:', error);
    return NextResponse.json(
      { error: '获取图片缓存统计失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}

/** 手动触发清理：不传 limit 时使用管理界面配置的上限 */
export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '不支持本地存储进行管理员配置' },
      { status: 400 }
    );
  }

  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const username = authInfo.username;
    if (username !== process.env.USERNAME && !(await isAdmin(username))) {
      return NextResponse.json({ error: '权限不足' }, { status: 401 });
    }

    let bodyLimit: number | undefined;
    try {
      const body = await request.json();
      if (body && typeof body.limit === 'number') bodyLimit = body.limit;
    } catch {
      // 允许无 body 调用
    }

    let limit = bodyLimit;
    if (limit == null || !Number.isFinite(limit)) {
      const config = await getConfig();
      const configured = Number(config?.SiteConfig?.ImageCacheLimit);
      limit = Number.isFinite(configured) ? configured : DEFAULT_IMAGE_CACHE_LIMIT;
    }
    limit = Math.max(0, Math.floor(limit));

    const result = await cleanupImageCache(limit);
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('清理图片缓存失败:', error);
    return NextResponse.json(
      { error: '清理图片缓存失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
