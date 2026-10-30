/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * 本地磁盘版 R2 兼容存储（自托管降级方案）。
 *
 * 在非 Cloudflare 环境（Docker / VPS / Node standalone）下没有 R2 绑定，
 * 图片缓存与视频缓存会整体不可用。本模块用本地文件系统实现与 R2 相同的
 * get / put / head / delete / list 子集，让缓存功能在自托管下等效可用。
 *
 * 存储布局：
 *   <root>/img/<sha256>                    图片对象
 *   <root>/v/<epHash>/playlist.m3u8        视频播放列表
 *   <root>/v/<epHash>/s/<sha256>           视频分片
 *   同名 + ".meta.json" 后缀文件保存 customMetadata
 *
 * 可用环境变量：
 *   LOCAL_CACHE_DIR    缓存根目录（默认 <cwd>/cache）
 *   DISABLE_LOCAL_CACHE=true  禁用本地缓存降级（恢复"未绑定"行为）
 */

import type { Dirent } from 'fs';
import fsp from 'fs/promises';
import path from 'path';

export interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  size?: number;
  customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: any
  ): Promise<any>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<R2ObjectLike | null>;
  list(options?: any): Promise<{
    objects: Array<{ key: string; size?: number; customMetadata?: Record<string, string> }>;
    delimitedPrefixes?: string[];
    truncated?: boolean;
    cursor?: string;
  }>;
}

const META_SUFFIX = '.meta.json';

/** 缓存根目录：默认应用目录下的 cache/ */
function baseDir(scope: string): string {
  const root = process.env.LOCAL_CACHE_DIR || path.join(process.cwd(), 'cache');
  return path.join(root, scope);
}

/** 校验并解析对象键为安全路径：防止路径穿越 */
function safePath(root: string, key: string): string {
  if (!key || key.startsWith('/') || key.includes('\\')) {
    throw new Error(`非法缓存键: ${key}`);
  }
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`非法缓存键: ${key}`);
  }
  for (const seg of key.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`非法缓存键: ${key}`);
    }
  }
  return resolved;
}

function toBuffer(value: ArrayBuffer | string): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf-8') : Buffer.from(value);
}

async function readMeta(objPath: string): Promise<Record<string, string> | undefined> {
  try {
    const raw = await fsp.readFile(objPath + META_SUFFIX, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

class LocalDiskBucket implements R2BucketLike {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private async readObject(objPath: string, withBody: boolean): Promise<R2ObjectLike | null> {
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(objPath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;

    const meta = await readMeta(objPath);
    const size = stat.size;

    // head 与 get 都返回惰性方法：不读取 body 就不会产生内存开销
    void withBody;
    return {
      size,
      customMetadata: meta,
      arrayBuffer: async () => {
        const buf = await fsp.readFile(objPath);
        // 拷贝到独立 ArrayBuffer，避免 Node Buffer 池带来的共享内存问题
        const ab = new ArrayBuffer(buf.byteLength);
        Buffer.from(ab).set(buf);
        return ab;
      },
      text: async () => fsp.readFile(objPath, 'utf-8'),
    };
  }

  async get(key: string): Promise<R2ObjectLike | null> {
    return this.readObject(safePath(this.root, key), true);
  }

  async head(key: string): Promise<R2ObjectLike | null> {
    return this.readObject(safePath(this.root, key), false);
  }

  async put(key: string, value: ArrayBuffer | string, options?: any): Promise<any> {
    const objPath = safePath(this.root, key);
    const buf = toBuffer(value);

    await fsp.mkdir(path.dirname(objPath), { recursive: true });

    // 原子写入：先写临时文件再 rename，避免读取到半截内容
    const tmp = `${objPath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, objPath);

    const meta =
      options && options.customMetadata && typeof options.customMetadata === 'object'
        ? options.customMetadata
        : undefined;
    if (meta) {
      const metaTmp = `${objPath}${META_SUFFIX}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(metaTmp, JSON.stringify(meta), 'utf-8');
      await fsp.rename(metaTmp, objPath + META_SUFFIX);
    }
    return { key, size: buf.byteLength };
  }

  async delete(key: string): Promise<void> {
    const objPath = safePath(this.root, key);
    await fsp.rm(objPath, { force: true });
    await fsp.rm(objPath + META_SUFFIX, { force: true });
  }

  /**
   * 列举对象。支持：
   * - prefix：仅列举该前缀下的对象
   * - delimiter: '/'：返回一级子目录到 delimitedPrefixes（模拟 R2 行为）
   * - include: ['customMetadata']：附带自定义元数据
   * - cursor + limit：按键名排序翻页（cursor 为上一页最后一个键，base64 编码）
   */
  async list(options?: any): Promise<{
    objects: Array<{ key: string; size?: number; customMetadata?: Record<string, string> }>;
    delimitedPrefixes?: string[];
    truncated?: boolean;
    cursor?: string;
  }> {
    const opts = options || {};
    const prefix: string = typeof opts.prefix === 'string' ? opts.prefix : '';
    const delimiter: string | undefined = opts.delimiter;
    const limit: number = Number(opts.limit) || 1000;
    const includeMeta: boolean =
      Array.isArray(opts.include) && opts.include.includes('customMetadata');

    // 解析 cursor（上一页最后键）
    let afterKey = '';
    if (opts.cursor) {
      try {
        afterKey = Buffer.from(String(opts.cursor), 'base64url').toString('utf-8');
      } catch {
        afterKey = '';
      }
    }

    const prefixDir = prefix ? safePath(this.root, prefix.replace(/\/$/, '')) : this.root;

    // 递归收集 prefix 下所有对象文件（跳过元数据文件与临时文件）
    const files: string[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), childRel);
        } else if (
          !entry.name.endsWith(META_SUFFIX) &&
          !entry.name.includes('.tmp-')
        ) {
          files.push(childRel);
        }
      }
    };
    await walk(prefixDir, prefix ? prefix.replace(/\/$/, '') : '');

    files.sort();

    // delimiter 模式：一级子目录聚合为 delimitedPrefixes，与对象按键名合并成统一流
    type Entry = { type: 'dir' | 'obj'; key: string };
    let entries: Entry[] = files.map((rel) => ({ type: 'obj' as const, key: rel }));
    if (delimiter === '/') {
      const dirs = new Set<string>();
      const flat: string[] = [];
      for (const rel of files) {
        const slashIdx = rel.indexOf('/', prefix.length);
        if (slashIdx !== -1) {
          dirs.add(rel.slice(0, slashIdx + 1));
        } else {
          flat.push(rel);
        }
      }
      entries = [
        ...Array.from(dirs).sort().map((p) => ({ type: 'dir' as const, key: p })),
        ...flat.map((rel) => ({ type: 'obj' as const, key: rel })),
      ];
      entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }

    // 分页：对统一流按键排序翻页（cursor 为上一页最后一个键，base64 编码）
    const startIdx =
      afterKey > '' ? entries.findIndex((e) => e.key > afterKey) : 0;
    const from = startIdx === -1 ? entries.length : startIdx;
    const pageEntries = entries.slice(from, from + limit);
    const truncated = from + limit < entries.length;
    const cursor = truncated
      ? Buffer.from(pageEntries[pageEntries.length - 1].key, 'utf-8').toString('base64url')
      : undefined;

    const delimitedPrefixes = delimiter
      ? pageEntries.filter((e) => e.type === 'dir').map((e) => e.key)
      : undefined;
    const pageKeys = pageEntries.filter((e) => e.type === 'obj').map((e) => e.key);

    const objects: Array<{ key: string; size?: number; customMetadata?: Record<string, string> }> =
      [];
    for (const rel of pageKeys) {
      try {
        const stat = await fsp.stat(path.join(this.root, rel));
        const entry: { key: string; size?: number; customMetadata?: Record<string, string> } = {
          key: rel,
          size: stat.size,
        };
        if (includeMeta) entry.customMetadata = await readMeta(path.join(this.root, rel));
        objects.push(entry);
      } catch {
        // 并发删除等竞态：跳过
      }
    }

    return { objects, delimitedPrefixes, truncated, cursor };
  }
}

/** 自托管本地缓存桶：scope 区分图片/视频，避免相互污染统计 */
export function getLocalDiskBucket(scope: 'image' | 'video'): R2BucketLike | null {
  if (process.env.DISABLE_LOCAL_CACHE === 'true') return null;
  return new LocalDiskBucket(baseDir(scope));
}
