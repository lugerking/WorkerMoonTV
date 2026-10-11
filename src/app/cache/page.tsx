/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

'use client';

import { ChevronDown, ChevronRight, HardDrive, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Swal from 'sweetalert2';

import PageLayout from '@/components/PageLayout';
import { getAuthInfoFromBrowserCookie } from '@/lib/auth';

interface CachedEpisode {
  epHash: string;
  src: string;
  title: string;
  bytes: number;
  count: number;
  lastAccess: number;
  source: string;
  vid: string;
  epIndex: number;
  epTotal: number;
}

interface Stats {
  available: boolean;
  episodes: CachedEpisode[];
  bytes: number;
  limitGB: number;
}

interface Group {
  key: string;
  title: string;
  source: string;
  vid: string;
  epTotal: number;
  cached: Map<number, CachedEpisode>;
  bytes: number;
  lastAccess: number;
}

const showError = (message: string) =>
  Swal.fire({ icon: 'error', title: '错误', text: message });

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const v = bytes / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function CachePageClient() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>('');
  // 展开分组时拉取的完整剧集列表（用于显示未缓存的集并支持批量缓存）
  const [detailEpisodes, setDetailEpisodes] = useState<
    Record<string, string[]>
  >({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  useEffect(() => {
    const auth = getAuthInfoFromBrowserCookie();
    const admin = auth?.role === 'owner' || auth?.role === 'admin';
    setIsAdmin(admin);
    if (!admin) setLoading(false);
  }, []);

  const loadStats = useCallback(async () => {
    try {
      setLoading(true);
      const resp = await fetch('/api/admin/video-cache');
      if (!resp.ok) throw new Error(`获取失败: ${resp.status}`);
      setStats(await resp.json());
    } catch (err) {
      showError(err instanceof Error ? err.message : '获取缓存列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) loadStats();
  }, [isAdmin, loadStats]);

  // 按影片聚合（归属信息缺失的旧数据按标题聚合）
  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const ep of stats?.episodes ?? []) {
      const key =
        ep.source && ep.vid ? `${ep.source}+${ep.vid}` : `title:${ep.title}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          title: ep.title || '未知影片',
          source: ep.source,
          vid: ep.vid,
          epTotal: ep.epTotal || 0,
          cached: new Map<number, CachedEpisode>(),
          bytes: 0,
          lastAccess: 0,
        };
        map.set(key, g);
      }
      g.bytes += ep.bytes;
      g.lastAccess = Math.max(g.lastAccess, ep.lastAccess);
      if (ep.epTotal > g.epTotal) g.epTotal = ep.epTotal;
      // 同一集可能有重复条目，取较大的
      const prev = g.cached.get(ep.epIndex);
      if (!prev || ep.bytes > prev.bytes) g.cached.set(ep.epIndex, ep);
    }
    return Array.from(map.values()).sort((a, b) => b.lastAccess - a.lastAccess);
  }, [stats]);

  const toggleSelect = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const loadDetail = async (g: Group) => {
    if (!g.source || !g.vid) return;
    if (detailEpisodes[g.key]) return;
    setDetailLoading(g.key);
    try {
      const resp = await fetch(
        `/api/detail?source=${encodeURIComponent(g.source)}&id=${encodeURIComponent(g.vid)}`
      );
      if (!resp.ok) throw new Error(`获取详情失败: ${resp.status}`);
      const data = await resp.json();
      setDetailEpisodes((prev) => ({ ...prev, [g.key]: data?.episodes ?? [] }));
    } catch (err) {
      console.error('获取剧集列表失败:', err);
    } finally {
      setDetailLoading(null);
    }
  };

  const toggleExpand = (g: Group) => {
    const next = expanded === g.key ? null : g.key;
    setExpanded(next);
    if (next) loadDetail(g);
  };

  const handleDeleteSelected = async () => {
    const urls = Array.from(selected).filter((u) => cachedUrlSet.has(u));
    if (urls.length === 0) {
      Swal.fire('提示', '请先选择已缓存的集', 'info');
      return;
    }
    const confirm = await Swal.fire({
      icon: 'warning',
      title: '确认删除',
      text: `将删除 ${urls.length} 集的缓存，是否继续？`,
      showCancelButton: true,
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    if (!confirm.isConfirmed) return;
    try {
      setBusy(true);
      setProgress(`删除中 0/${urls.length}`);
      const resp = await fetch('/api/admin/video-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteBatch', urls }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `删除失败: ${resp.status}`);
      setSelected(new Set());
      await loadStats();
      Swal.fire({
        icon: 'success',
        title: '删除完成',
        text: `已删除 ${data.deleted} 集${data.incomplete ? '（部分未删净，可再次操作）' : ''}`,
        timer: 2000,
        showConfirmButton: false,
      });
    } catch (err) {
      showError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const handleCacheSelected = async () => {
    // 批量缓存：按分组收集待缓存集（包含尚未缓存的集）
    const tasks: Array<{
      url: string;
      source: string;
      vid: string;
      epIndex: number;
      epTotal: number;
      title: string;
    }> = [];
    for (const g of groups) {
      const list = detailEpisodes[g.key];
      if (!list) continue;
      list.forEach((url, idx) => {
        if (url && selected.has(url)) {
          tasks.push({
            url,
            source: g.source,
            vid: g.vid,
            epIndex: idx,
            epTotal: list.length,
            title: g.title,
          });
        }
      });
    }
    if (tasks.length === 0) {
      Swal.fire(
        '提示',
        '请先展开影片并勾选要缓存的集（未缓存的集需展开后才会显示）',
        'info'
      );
      return;
    }
    try {
      setBusy(true);
      for (let t = 0; t < tasks.length; t++) {
        const task = tasks[t];
        let offset = 0;
        for (let i = 0; i < 2000; i++) {
          const resp = await fetch('/api/admin/video-cache', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'cache',
              url: task.url,
              title: task.title,
              offset,
              source: task.source,
              vid: task.vid,
              epIndex: task.epIndex,
              epTotal: task.epTotal,
            }),
          });
          if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || `缓存失败: ${resp.status}`);
          }
          const data = await resp.json();
          offset = data.nextOffset || 0;
          setProgress(
            `缓存中 ${t + 1}/${tasks.length} 集 · ${offset}/${data.total || 0} 分片`
          );
          if (data.done) break;
        }
      }
      await loadStats();
      Swal.fire({
        icon: 'success',
        title: '缓存完成',
        text: `已处理 ${tasks.length} 集`,
        timer: 2000,
        showConfirmButton: false,
      });
    } catch (err) {
      showError(err instanceof Error ? err.message : '缓存失败');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const cachedUrlSet = useMemo(() => {
    const s = new Set<string>();
    for (const ep of stats?.episodes ?? []) if (ep.src) s.add(ep.src);
    return s;
  }, [stats]);

  const allVisibleUrls = useMemo(() => {
    const urls: string[] = [];
    for (const g of groups) {
      const list = detailEpisodes[g.key];
      if (expanded === g.key && list) {
        for (const u of list) if (u) urls.push(u);
      } else {
        for (const ep of Array.from(g.cached.values())) {
          if (ep.src) urls.push(ep.src);
        }
      }
    }
    return urls;
  }, [groups, detailEpisodes, expanded]);

  if (isAdmin === false) {
    return (
      <PageLayout activePath='/cache'>
        <div className='px-4 sm:px-10 py-10 text-center text-gray-500 dark:text-gray-400'>
          仅管理员可访问缓存管理
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout activePath='/cache'>
      <div className='px-4 sm:px-10 py-4 sm:py-8 mb-10'>
        <div className='max-w-4xl mx-auto'>
          <div className='flex items-center justify-between mb-6 gap-4 flex-wrap'>
            <h1 className='text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2'>
              <HardDrive className='h-6 w-6' />
              视频缓存
            </h1>
            <div className='text-sm text-gray-500 dark:text-gray-400'>
              {stats
                ? `已缓存 ${stats.episodes.length} 集，占用 ${formatBytes(
                    stats.bytes
                  )}，上限 ${stats.limitGB} GB`
                : '加载中…'}
            </div>
          </div>

          {/* 批量操作 */}
          <div className='flex items-center gap-2 mb-4 flex-wrap'>
            <button
              onClick={() =>
                setSelected((prev) =>
                  prev.size === allVisibleUrls.length
                    ? new Set()
                    : new Set(allVisibleUrls)
                )
              }
              disabled={busy || allVisibleUrls.length === 0}
              className='px-3 py-1.5 text-sm rounded bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-100 disabled:opacity-50'
            >
              {selected.size === allVisibleUrls.length && allVisibleUrls.length > 0
                ? '取消全选'
                : '全选'}
            </button>
            <button
              onClick={handleCacheSelected}
              disabled={busy || selected.size === 0}
              className='px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50'
            >
              缓存选中
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={busy || selected.size === 0}
              className='px-3 py-1.5 text-sm rounded bg-red-500 hover:bg-red-600 text-white disabled:opacity-50'
            >
              删除选中
            </button>
            <span className='text-sm text-gray-500 dark:text-gray-400'>
              已选 {selected.size}
            </span>
            {busy && progress && (
              <span className='text-sm text-blue-600 dark:text-blue-400'>
                {progress}
              </span>
            )}
          </div>

          {loading ? (
            <div className='text-center text-gray-500 dark:text-gray-400 py-10'>
              加载中…
            </div>
          ) : groups.length === 0 ? (
            <div className='text-center text-gray-500 dark:text-gray-400 py-10'>
              还没有缓存任何视频，可在播放页点击「缓存本集」
            </div>
          ) : (
            <div className='space-y-2'>
              {groups.map((g) => {
                const list = detailEpisodes[g.key];
                const isOpen = expanded === g.key;
                const total = list?.length || g.epTotal || g.cached.size;
                const cachedCount = g.cached.size;
                return (
                  <div
                    key={g.key}
                    className='border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden'
                  >
                    <div
                      className='flex items-center gap-3 px-3 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5'
                      onClick={() => toggleExpand(g)}
                    >
                      {isOpen ? (
                        <ChevronDown className='h-4 w-4 text-gray-500 flex-shrink-0' />
                      ) : (
                        <ChevronRight className='h-4 w-4 text-gray-500 flex-shrink-0' />
                      )}
                      <div className='flex-1 min-w-0'>
                        <div className='font-medium text-gray-900 dark:text-gray-100 truncate'>
                          {g.title}
                        </div>
                        <div className='text-xs text-gray-500 dark:text-gray-400 mt-0.5'>
                          已缓存 {cachedCount}/{total || '?'} 集 ·{' '}
                          {formatBytes(g.bytes)}
                          {g.source ? ` · ${g.source}` : ''}
                        </div>
                      </div>
                      {g.cached.size > 0 && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            const urls = Array.from(g.cached.values())
                              .map((ep) => ep.src)
                              .filter(Boolean);
                            if (urls.length === 0) return;
                            const confirm = await Swal.fire({
                              icon: 'warning',
                              title: '确认删除',
                              text: `将删除《${g.title}》的 ${urls.length} 集缓存`,
                              showCancelButton: true,
                              confirmButtonText: '删除',
                              cancelButtonText: '取消',
                            });
                            if (!confirm.isConfirmed) return;
                            try {
                              setBusy(true);
                              const resp = await fetch('/api/admin/video-cache', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  action: 'deleteBatch',
                                  urls,
                                }),
                              });
                              const data = await resp.json().catch(() => ({}));
                              if (!resp.ok)
                                throw new Error(data.error || '删除失败');
                              await loadStats();
                            } catch (err) {
                              showError(
                                err instanceof Error ? err.message : '删除失败'
                              );
                            } finally {
                              setBusy(false);
                            }
                          }}
                          disabled={busy}
                          className='text-xs px-2 py-1 rounded bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 disabled:opacity-50 flex-shrink-0'
                        >
                          <Trash2 className='h-3.5 w-3.5' />
                        </button>
                      )}
                    </div>

                    {isOpen && (
                      <div className='px-3 pb-3 pt-1 border-t border-gray-100 dark:border-gray-700/50'>
                        {detailLoading === g.key ? (
                          <div className='text-sm text-gray-500 py-2'>
                            加载剧集列表…
                          </div>
                        ) : list && list.length > 0 ? (
                          <div className='grid grid-cols-3 sm:grid-cols-5 md:grid-cols-8 gap-2'>
                            {list.map((url, idx) => {
                              const isCached = g.cached.has(idx);
                              const isSel = url ? selected.has(url) : false;
                              return (
                                <button
                                  key={`${g.key}-${idx}`}
                                  disabled={!url || busy}
                                  onClick={() => url && toggleSelect(url)}
                                  className={`px-2 py-1.5 text-xs rounded border transition-colors ${
                                    isCached
                                      ? 'border-green-500/50 bg-green-500/10 text-green-700 dark:text-green-400'
                                      : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'
                                  } ${isSel ? 'ring-2 ring-blue-500' : ''} ${
                                    !url ? 'opacity-40' : ''
                                  }`}
                                  title={
                                    isCached
                                      ? `已缓存 ${formatBytes(
                                          g.cached.get(idx)?.bytes || 0
                                        )}`
                                      : '未缓存'
                                  }
                                >
                                  第{idx + 1}集
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <div className='grid grid-cols-3 sm:grid-cols-5 md:grid-cols-8 gap-2'>
                            {Array.from(g.cached.entries())
                              .sort((a, b) => a[0] - b[0])
                              .map(([idx, ep]) => {
                                const isSel = ep.src ? selected.has(ep.src) : false;
                                return (
                                  <button
                                    key={`${g.key}-c-${idx}`}
                                    disabled={!ep.src || busy}
                                    onClick={() => ep.src && toggleSelect(ep.src)}
                                    className={`px-2 py-1.5 text-xs rounded border border-green-500/50 bg-green-500/10 text-green-700 dark:text-green-400 ${
                                      isSel ? 'ring-2 ring-blue-500' : ''
                                    }`}
                                    title={`已缓存 ${formatBytes(ep.bytes)}`}
                                  >
                                    {idx >= 0 ? `第${idx + 1}集` : '已缓存'}
                                  </button>
                                );
                              })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

export default function CachePage() {
  return <CachePageClient />;
}
