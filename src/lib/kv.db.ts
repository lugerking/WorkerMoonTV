/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { AdminConfig } from './admin.types';

/**
 * 管理员配置的 Cloudflare Workers KV 存储。
 *
 * 配置属于「全局单份、读极多、写极少」的数据，故存于 KV（绑定 `CONFIG_KV`）。
 *
 * **分片设计**：不再用一个 key 存整份 JSON，而是按 `AdminConfig` 的顶层字段
 * 拆分为 4 个 key：
 *
 * | key                        | 对应字段           | 主要写入方        |
 * | -------------------------- | ------------------ | ----------------- |
 * | `admin_config:site`        | `SiteConfig`       | 站点配置 Tab      |
 * | `admin_config:sources`     | `SourceConfig`     | 视频源 Tab        |
 * | `admin_config:categories`  | `CustomCategories` | 自定义分类 Tab    |
 * | `admin_config:users`       | `UserConfig`       | 用户 Tab / 注册   |
 *
 * 好处：修改某一类配置时只写对应分片，避免「改一个字段也重写整份配置」的写放大，
 * 也缩小了并发写入的冲突面。读取时 4 个分片并发获取后组装。
 *
 * 兼容：若检测到旧版整份 key `admin_config`，会自动拆分迁移到 4 个分片并删除旧 key。
 */
const KV_BINDING = 'CONFIG_KV';

const KEY_SITE = 'admin_config:site';
const KEY_SOURCES = 'admin_config:sources';
const KEY_CATEGORIES = 'admin_config:categories';
const KEY_USERS = 'admin_config:users';
/** 旧版本使用的整份配置 key（仅用于一次性自动迁移） */
const KEY_LEGACY = 'admin_config';

type SiteConfig = AdminConfig['SiteConfig'];
type UserConfig = AdminConfig['UserConfig'];
type SourceItem = AdminConfig['SourceConfig'][number];
type SourceConfigList = AdminConfig['SourceConfig'];
type CategoryItem = AdminConfig['CustomCategories'][number];
type CategoryList = AdminConfig['CustomCategories'];

// 最小化的 Workers KV 类型（项目未引入 @cloudflare/workers-types，故本地声明，
// 与 d1.db.ts 中本地声明 D1Database 的做法一致）
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
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

/** 读取并解析某个分片；不存在或解析失败时返回 null。 */
async function readShard<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`解析 KV 分片 ${key} 失败:`, err);
    return null;
  }
}

/** 写入某个分片（JSON 序列化）。 */
async function writeShard(
  kv: KVNamespace,
  key: string,
  value: unknown
): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}

/**
 * 读取管理员配置：并发读取 4 个分片后组装。
 *
 * - 任一分片存在即视为已初始化；
 * - 若 4 个分片都不存在但存在旧版整份 key，则自动拆分迁移并返回；
 * - 全部不存在则返回 null（由 `config.ts` 用环境变量 + config.json 完成初始化）。
 */
export async function getAdminConfig(): Promise<AdminConfig | null> {
  const kv = getKV();
  if (!kv) return null;

  try {
    const [site, users, sources, categories] = await Promise.all([
      readShard<SiteConfig>(kv, KEY_SITE),
      readShard<UserConfig>(kv, KEY_USERS),
      readShard<SourceConfigList>(kv, KEY_SOURCES),
      readShard<CategoryList>(kv, KEY_CATEGORIES),
    ]);

    if (site || users || sources || categories) {
      return {
        SiteConfig: site ?? ({} as SiteConfig),
        UserConfig: users ?? { AllowRegister: false, Users: [] },
        SourceConfig: sources ?? [],
        CustomCategories: categories ?? [],
      };
    }

    // 兼容旧版：整份配置存于单个 key，自动拆分迁移后返回
    const legacy = await readShard<AdminConfig>(kv, KEY_LEGACY);
    if (!legacy) return null;

    await setAdminConfig(legacy);
    try {
      await kv.delete(KEY_LEGACY);
    } catch (err) {
      console.error('删除旧版 KV 配置 key 失败:', err);
    }
    return legacy;
  } catch (err) {
    console.error('读取 KV 管理员配置失败:', err);
    return null;
  }
}

/** 写入整份管理员配置（拆分为 4 个分片并发写入）。 */
export async function setAdminConfig(config: AdminConfig): Promise<void> {
  const kv = getKV();
  if (!kv) return;

  try {
    await Promise.all([
      writeShard(kv, KEY_SITE, config.SiteConfig ?? {}),
      writeShard(
        kv,
        KEY_USERS,
        config.UserConfig ?? { AllowRegister: false, Users: [] }
      ),
      writeShard(kv, KEY_SOURCES, config.SourceConfig ?? []),
      writeShard(kv, KEY_CATEGORIES, config.CustomCategories ?? []),
    ]);
  } catch (err) {
    console.error('写入 KV 管理员配置失败:', err);
    throw err;
  }
}

/** 仅写入「站点设置」分片（站点配置 Tab）。 */
export async function setSiteConfig(site: SiteConfig): Promise<void> {
  const kv = getKV();
  if (!kv) return;
  await writeShard(kv, KEY_SITE, site);
}

/** 仅写入「视频源」分片（视频源 Tab）。 */
export async function setSourceConfig(
  sources: SourceConfigList
): Promise<void> {
  const kv = getKV();
  if (!kv) return;
  await writeShard(kv, KEY_SOURCES, sources);
}

/** 仅写入「自定义分类」分片（分类配置 Tab）。 */
export async function setCategoryConfig(
  categories: CategoryList
): Promise<void> {
  const kv = getKV();
  if (!kv) return;
  await writeShard(kv, KEY_CATEGORIES, categories);
}

/** 仅写入「用户配置」分片（用户 Tab / 注册流程）。 */
export async function setUserConfig(user: UserConfig): Promise<void> {
  const kv = getKV();
  if (!kv) return;
  await writeShard(kv, KEY_USERS, user);
}

export type { CategoryItem, SiteConfig, SourceItem, UserConfig };
