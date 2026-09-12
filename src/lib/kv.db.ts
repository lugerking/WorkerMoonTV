/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { AdminConfig } from './admin.types';

/**
 * 管理员配置的 Cloudflare Workers KV 存储。
 *
 * 管理员配置是「全局单份、读极多、写极少」的数据，因此从 D1 的 `admin_config`
 * 表迁移到 KV：
 * - 读取走边缘缓存，延迟低，几乎不消耗 D1 的读配额；
 * - 写入频率极低（仅管理后台操作），KV 最终一致性的影响可忽略。
 *
 * 绑定名：`CONFIG_KV`（见 wrangler.jsonc）。
 */
const KV_BINDING = 'CONFIG_KV';
const CONFIG_KEY = 'admin_config';

// 最小化的 Workers KV 类型（项目未引入 @cloudflare/workers-types，故本地声明，
// 与 d1.db.ts 中本地声明 D1Database 的做法一致）
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/**
 * 获取 KV 绑定。
 *
 * OpenNext 只会把「字符串型」环境变量注入 `process.env`，对象型绑定（KV / D1）
 * 需要通过 Cloudflare 上下文的全局符号读取；构建期或非 Workers 环境下返回
 * null（此时回退为环境变量/config.json 的默认配置）。
 */
function getKV(): KVNamespace | null {
  try {
    const ctx = (globalThis as any)[Symbol.for('__cloudflare-context__')];
    return (ctx?.env?.[KV_BINDING] as KVNamespace) ?? null;
  } catch {
    return null;
  }
}

/** 读取管理员配置（KV）；不存在或不可用时返回 null。 */
export async function getAdminConfig(): Promise<AdminConfig | null> {
  const kv = getKV();
  if (!kv) return null;

  try {
    const raw = await kv.get(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as AdminConfig) : null;
  } catch (err) {
    console.error('读取 KV 管理员配置失败:', err);
    return null;
  }
}

/** 写入管理员配置（KV，整份覆盖）。 */
export async function setAdminConfig(config: AdminConfig): Promise<void> {
  const kv = getKV();
  if (!kv) return;

  try {
    await kv.put(CONFIG_KEY, JSON.stringify(config));
  } catch (err) {
    console.error('写入 KV 管理员配置失败:', err);
    throw err;
  }
}
