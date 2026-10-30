/* eslint-disable no-console */

import { getRedisClient } from './redis.db';
import { DoubanItem } from './types';

// 豆瓣推荐数据每日更新一次：缓存有效期 24 小时
const DOUBAN_CACHE_TTL_SECONDS = 24 * 60 * 60;

// rexxar 上游响应结构（subset）
interface DoubanCategoryApiResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    card_subtitle: string;
    pic: {
      large: string;
      normal: string;
    };
    rating: {
      value: number;
    };
  }>;
}

async function fetchDoubanData(url: string): Promise<DoubanCategoryApiResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const fetchOptions = {
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: 'https://movie.douban.com/',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://movie.douban.com',
    },
  };

  try {
    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// 回源抓取并转换为 DoubanItem 列表
async function fetchCategoryList(params: {
  kind: string;
  category: string;
  type: string;
  limit: number;
  start: number;
}): Promise<DoubanItem[]> {
  const { kind, category, type, limit, start } = params;
  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${start}&limit=${limit}&category=${category}&type=${type}`;
  const doubanData = await fetchDoubanData(target);

  return doubanData.items.map((item) => ({
    id: item.id,
    title: item.title,
    poster: item.pic?.normal || item.pic?.large || '',
    rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
    year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
  }));
}

// ---------- 缓存层：Redis 优先，内存降级 ----------

interface MemoryCacheEntry {
  value: DoubanItem[];
  expires: number;
}

const memoryCache = new Map<string, MemoryCacheEntry>();

function buildCacheKey(params: {
  kind: string;
  category: string;
  type: string;
  limit: number;
  start: number;
}): string {
  const { kind, category, type, limit, start } = params;
  return `douban:cat:${kind}:${category}:${type}:${limit}:${start}`;
}

async function readRedis(key: string): Promise<DoubanItem[] | null> {
  if ((process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') !== 'redis') {
    return null;
  }
  try {
    const client = getRedisClient();
    const raw = await client.get(key);
    return raw ? (JSON.parse(raw) as DoubanItem[]) : null;
  } catch (error) {
    console.error('[douban-cache] Redis 读取失败，降级内存缓存:', error);
    return null;
  }
}

async function writeRedis(key: string, value: DoubanItem[]): Promise<void> {
  if ((process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') !== 'redis') {
    return;
  }
  try {
    const client = getRedisClient();
    await client.set(key, JSON.stringify(value), {
      EX: DOUBAN_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.error('[douban-cache] Redis 写入失败:', error);
  }
}

export interface DoubanCacheResult {
  list: DoubanItem[];
  /** redis: 命中 Redis 缓存；memory: 命中进程内存；fresh: 刚回源 */
  cached: 'redis' | 'memory' | 'fresh';
}

/**
 * 带缓存的豆瓣分类数据获取：
 * Redis（24h TTL）→ 进程内存（24h TTL）→ 回源豆瓣并写缓存。
 * 首页等高频读路径直接命中数据库，每日由 cron 预刷新。
 */
export async function getCachedDoubanCategoryList(params: {
  kind: string;
  category: string;
  type: string;
  limit: number;
  start: number;
}): Promise<DoubanCacheResult> {
  const key = buildCacheKey(params);

  const redisHit = await readRedis(key);
  if (redisHit && redisHit.length > 0) {
    return { list: redisHit, cached: 'redis' };
  }

  const mem = memoryCache.get(key);
  if (mem && mem.expires > Date.now() && mem.value.length > 0) {
    return { list: mem.value, cached: 'memory' };
  }

  const list = await fetchCategoryList(params);
  memoryCache.set(key, {
    value: list,
    expires: Date.now() + DOUBAN_CACHE_TTL_SECONDS * 1000,
  });
  await writeRedis(key, list);
  return { list, cached: 'fresh' };
}

// ---------- cron 每日预刷新 ----------

/** 首页三个推荐区块的固定参数（与 page.tsx 保持一致） */
export const DOUBAN_HOMEPAGE_COMBOS = [
  { kind: 'movie', category: '热门', type: '全部' },
  { kind: 'tv', category: 'tv', type: 'tv' },
  { kind: 'tv', category: 'show', type: 'show' },
] as const;

/**
 * 强制回源刷新单个组合的缓存（绕过读缓存），
 * 供 cron 每日预刷新使用，保证用户打开首页时缓存总是热的。
 */
export async function refreshDoubanCategoryCache(params: {
  kind: string;
  category: string;
  type: string;
  limit?: number;
  start?: number;
}): Promise<{ key: string; count: number }> {
  const full = { limit: 20, start: 0, ...params };
  const key = buildCacheKey(full);
  const list = await fetchCategoryList(full);
  memoryCache.set(key, {
    value: list,
    expires: Date.now() + DOUBAN_CACHE_TTL_SECONDS * 1000,
  });
  await writeRedis(key, list);
  return { key, count: list.length };
}

export async function refreshHomepageDoubanCache(): Promise<{
  total: number;
  results: Array<{ combo: string; count: number }>;
  errors: string[];
}> {
  const results: Array<{ combo: string; count: number }> = [];
  const errors: string[] = [];

  for (const combo of DOUBAN_HOMEPAGE_COMBOS) {
    try {
      const { count } = await refreshDoubanCategoryCache({ ...combo });
      results.push({ combo: `${combo.kind}/${combo.category}/${combo.type}`, count });
    } catch (error) {
      const msg = `${combo.kind}/${combo.category}/${combo.type}: ${
        (error as Error).message
      }`;
      errors.push(msg);
      console.error('[douban-cache] 预刷新失败:', msg);
    }
  }

  return { total: results.length, results, errors };
}
