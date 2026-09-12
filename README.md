# WorkerMoonTV

MoonTV 的 **Cloudflare Workers** 版本。

MoonTV 是一个影视聚合搜索与播放应用（基于 Next.js App Router）。本目录将其从 Vercel / Cloudflare Pages 形态改造为标准的 Cloudflare Workers 应用，使用官方推荐的 [OpenNext Cloudflare](https://opennext.js.org/cloudflare) 适配器进行构建与部署，数据默认存储在 Cloudflare D1。

> 本项目为 `MoonTV-main`（Pages 版）的 Workers 版本，二者源码基本一致，差异见 [与上游 MoonTV 的差异](#与上游-moontv-的差异)。

---

## 技术栈

| 组件 | 版本 / 说明 |
| --- | --- |
| Next.js | 14.2.35（App Router） |
| React | 18 |
| `@opennextjs/cloudflare` | 1.15.0（支持 `next ^14.2.35`） |
| Wrangler | 4.x |
| Tailwind CSS | 3.x |
| 存储 | Cloudflare D1（默认）/ Redis / Upstash / localStorage |

---

## 目录结构

```
WorkerMoonTV/
├── src/
│   ├── app/                  # 页面与 API 路由（App Router）
│   │   ├── api/              # 23 个 API 路由（登录/注册/搜索/收藏/管理后台等）
│   │   ├── admin/ douban/ login/ play/ search/ warning/
│   │   ├── layout.tsx page.tsx globals.css
│   ├── components/           # React 组件
│   ├── lib/                  # 配置、存储层、工具
│   │   ├── db.ts             # 存储门面（DbManager）
│   │   ├── d1.db.ts          # D1 实现
│   │   ├── redis.db.ts       # Redis 实现
│   │   ├── upstash.db.ts     # Upstash 实现
│   │   ├── db.client.ts      # localStorage 客户端实现
│   │   ├── config.ts         # 配置体系
│   │   └── runtime.ts        # 由 config.json 自动生成（勿手改）
│   ├── styles/
│   └── middleware.ts         # 鉴权中间件（PASSWORD 保护）
├── public/                   # 静态资源（PWA 图标、manifest.json、sw.js 等）
├── scripts/
│   ├── convert-config.js     # config.json → src/lib/runtime.ts
│   └── generate-manifest.js  # 生成 public/manifest.json
├── config.json               # 站点配置（资源站 api_site、自定义分类等）
├── wrangler.jsonc            # Workers 部署配置（入口/绑定/变量/路由）
├── open-next.config.ts       # OpenNext 适配器配置
├── next.config.js            # Next 配置（含 PWA、SVG 处理）
├── tsconfig.json / next-env.d.ts
├── postcss.config.js / tailwind.config.ts
└── package.json
```

> `.open-next/` 为构建产物（部署时上传），`node_modules/` 为依赖，二者均不需提交版本库。

---

## 前置要求

- **Node.js 20+**（本项目在 Node 24 下构建通过）
- **npm**
- **Cloudflare 账号** 及 API Token（需 Workers Scripts、D1 等权限）

> Windows 用户：OpenNext 构建会调用 `bash`，请将 Git 的 `usr/bin`（或 `bin`）目录加入 `PATH`，并将 `node_modules/.bin` 与 Node 安装目录加入 `PATH`、`PATHEXT` 含 `.CMD`。

---

## 环境变量与绑定

### 一、`wrangler.jsonc` 中的明文变量（`vars`）

| 名称 | 说明 |
| --- | --- |
| `NEXT_PUBLIC_STORAGE_TYPE` | 存储类型：`d1` / `redis` / `upstash` / `localstorage` |
| `NEXT_PUBLIC_ENABLE_REGISTER` | 是否开放注册（`true` / `false`） |
| `USERNAME` | 站长用户名（数据库模式下即 owner 账号） |

### 二、密钥（Secret）

| 名称 | 说明 |
| --- | --- |
| `PASSWORD` | 访问密码，同时是 owner 登录密码 |

设置方式：

```bash
npx wrangler secret put PASSWORD
# 或使用 JSON 文件批量导入：npx wrangler secret bulk secrets.json
```

### 三、D1 绑定

| 绑定名 | 数据库 |
| --- | --- |
| `DB` | `moontvdatabase` |

> ⚠️ **绑定名必须为 `DB`**，应用代码按此名称读取。

> ⚠️ **`NEXT_PUBLIC_*` 变量会在构建时内联进产物**，因此**构建时也必须设置**同名环境变量（见 [构建与部署](#构建与部署)）。运行时变量只影响非内联的逻辑（如 `PASSWORD`、`USERNAME`）。

---

## D1 初始化

首次部署前，需在 D1 数据库中创建表结构（执行一次即可）：

```bash
npx wrangler d1 execute moontvdatabase --remote --file=schema.sql
```

`schema.sql` 内容（对应应用所需的 6 张表与索引）：

```sql
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS play_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  cover TEXT NOT NULL,
  year TEXT NOT NULL,
  index_episode INTEGER NOT NULL,
  total_episodes INTEGER NOT NULL,
  play_time INTEGER NOT NULL,
  total_time INTEGER NOT NULL,
  save_time INTEGER NOT NULL,
  search_title TEXT,
  UNIQUE(username, key)
);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  cover TEXT NOT NULL,
  year TEXT NOT NULL,
  total_episodes INTEGER NOT NULL,
  save_time INTEGER NOT NULL,
  UNIQUE(username, key)
);

CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  keyword TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE(username, keyword)
);

CREATE TABLE IF NOT EXISTS admin_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS skip_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  source TEXT NOT NULL,
  id_video TEXT NOT NULL,
  enable INTEGER NOT NULL DEFAULT 0,
  intro_time INTEGER NOT NULL DEFAULT 0,
  outro_time INTEGER NOT NULL DEFAULT 0,
  UNIQUE(username, source, id_video)
);

CREATE INDEX IF NOT EXISTS idx_play_records_username ON play_records(username);
CREATE INDEX IF NOT EXISTS idx_favorites_username ON favorites(username);
CREATE INDEX IF NOT EXISTS idx_search_history_username ON search_history(username);
CREATE INDEX IF NOT EXISTS idx_play_records_username_key ON play_records(username, key);
CREATE INDEX IF NOT EXISTS idx_play_records_username_save_time ON play_records(username, save_time DESC);
CREATE INDEX IF NOT EXISTS idx_favorites_username_key ON favorites(username, key);
CREATE INDEX IF NOT EXISTS idx_favorites_username_save_time ON favorites(username, save_time DESC);
CREATE INDEX IF NOT EXISTS idx_search_history_username_keyword ON search_history(username, keyword);
CREATE INDEX IF NOT EXISTS idx_search_history_username_created_at ON search_history(username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skip_configs_username_source_id ON skip_configs(username, source, id_video);
CREATE INDEX IF NOT EXISTS idx_search_history_username_id_created_at ON search_history(username, id, created_at DESC);
```

---

## 本地开发

```bash
npm install
npm run dev          # 自动生成 runtime/manifest 后启动 next dev
```

`npm run dev` 会通过 `next.config.js` 中的 `initOpenNextCloudflareForDev()` 接入 `wrangler.jsonc` 中配置的变量与 D1 绑定。

---

## 构建与部署

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 Cloudflare 凭据

```bash
# PowerShell
$env:CLOUDFLARE_API_TOKEN="<你的 API Token>"
# bash
export CLOUDFLARE_API_TOKEN="<你的 API Token>"
```

### 3. 构建（设置构建期内联变量）

```bash
# PowerShell
$env:NEXT_PUBLIC_STORAGE_TYPE="d1"; $env:NEXT_PUBLIC_ENABLE_REGISTER="true"; npm run build:worker

# bash
NEXT_PUBLIC_STORAGE_TYPE=d1 NEXT_PUBLIC_ENABLE_REGISTER=true npm run build:worker
```

构建脚本 `build:worker` 依次执行：`convert-config.js` → `generate-manifest.js` → `opennextjs-cloudflare build`，产物输出到 `.open-next/`。

### 4. 部署

```bash
npx wrangler deploy
# 或（含构建）：
npm run deploy
```

部署后可在 `wrangler.jsonc` 的 `routes` 中配置自定义域名（默认示例为 `workermoontv.mytvapp.qzz.io`，请改为你自己的域名）。

### 常用脚本

| 脚本 | 说明 |
| --- | --- |
| `npm run dev` | 本地开发 |
| `npm run build` | 仅执行 `next build`（OpenNext 内部会调用） |
| `npm run build:worker` | 完整 Workers 构建（生成 `.open-next/`） |
| `npm run preview` | 本地预览 Worker |
| `npm run deploy` | 构建并部署 |
| `npm run upload` | 构建并上传（不切换流量） |
| `npm run cf-typegen` | 生成 `CloudflareEnv` 类型 |

---

## 与上游 MoonTV 的差异

1. **部署适配**：用 `@opennextjs/cloudflare` 取代 `@cloudflare/next-on-pages`，产物为 Workers（`main=.open-next/worker.js` + `assets` 绑定 `ASSETS`）。
2. **运行时**：`src` 下 23 个 API 路由的 `export const runtime = 'edge'` 全部改为 `'nodejs'`（OpenNext 不支持 Next 14 的 edge 路由；Workers 配合 `nodejs_compat` 运行）。
3. **D1 绑定读取**：`src/lib/d1.db.ts` 通过 Cloudflare 上下文全局符号 `Symbol.for('__cloudflare-context__')` 获取绑定（`env.DB`），因为 OpenNext 只会把**字符串型**变量注入 `process.env`，对象型绑定不会出现在 `process.env`。
4. **构建配置**：`tsconfig.json` 排除 `open-next.config.ts`（避免 Next 类型检查报 CJS/ESM 冲突）；`next.config.js` 开启 `eslint.ignoreDuringBuilds`（已移除 ESLint 配置）。
5. **精简**：移除了 Docker、CI、测试、Lint、Prettier 等非运行必需文件与依赖。

---

## 常见问题

| 现象 | 排查方向 |
| --- | --- |
| `*.workers.dev` 无法访问 | 该域名在部分网络被 DNS 污染，请在 `wrangler.jsonc` 配置自定义域名 |
| 所有数据接口 500 | 检查 D1 绑定名是否为 `DB`、数据库是否已执行建表 SQL |
| 访问被重定向到 `/login` 或 `/warning` | 未配置 `PASSWORD` 密钥 |
| 注册提示"当前模式不支持注册" | `NEXT_PUBLIC_STORAGE_TYPE=localstorage` 模式不支持注册，需使用 `d1`/`redis`/`upstash` |
| 注册提示"当前未开放注册" | `NEXT_PUBLIC_ENABLE_REGISTER` 未设为 `true`（注意需在构建时设置并重新构建） |
| 构建报 `cannot use the edge runtime` | 有 `route.ts` 仍为 `runtime = 'edge'`，需改为 `'nodejs'` |
| Windows 构建报 `spawn bash/npx ENOENT` | 将 Git 的 bash 与 Node 目录加入 `PATH`、`PATHEXT` 含 `.CMD` |

---

## 安全提示

- 请务必设置强密码 `PASSWORD`。
- 用户密码为**明文存储**，且注册默认对公网开放，请按需关闭（`NEXT_PUBLIC_ENABLE_REGISTER=false`）或仅在可信环境使用。
- 仅供个人学习使用，请勿公开分享或商用。
