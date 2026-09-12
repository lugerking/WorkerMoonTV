# API 接口文档

所有接口位于 `src/app/api/**/route.ts`，均声明 `export const runtime = 'nodejs'`（经 OpenNext Cloudflare 运行于 Workers，配合 `nodejs_compat`）。

## 0. 通用约定

### 鉴权

- 除白名单外，所有接口均经过 `src/middleware.ts` 校验 `auth` Cookie。
- Cookie 内容为 URL 编码的 JSON：
  - localstorage 模式：`{ role, password }`
  - 数据库模式：`{ role, username, signature, timestamp }`，`signature = HMAC-SHA256(username, PASSWORD)`
- 未登录访问 API 时，中间件返回 `401` 纯文本 `Unauthorized`（注意不是 JSON）。
- 用户身份在接口中通过 `getAuthInfoFromCookie(request)` 获取（`src/lib/auth.ts`）。

### 缓存

搜索 / 详情 / 豆瓣类接口返回以下缓存头（`cacheTime` 来自 `SiteInterfaceCacheTime`，默认 7200 秒）：

```
Cache-Control: public, max-age=<t>, s-maxage=<t>
CDN-Cache-Control: public, s-maxage=<t>
Vercel-CDN-Cache-Control: public, s-maxage=<t>
```

管理类接口统一返回 `Cache-Control: no-store`。

### 免鉴权白名单（middleware）

`_next/static`、`_next/image`、`favicon.ico`、`login`、`warning`、`api/login`、`api/register`、`api/logout`、`api/cron`、`api/server-config`。

### 配置来源

站点配置以 **KV（`admin_config`）为准**，环境变量与 `config.json` 仅作默认值；管理类接口的修改会写入 KV 并即时生效（详见 [02-架构与数据流](./02-架构与数据流.md#3-配置体系与优先级)）。

---

## 1. 搜索类

### GET `/api/search`

聚合搜索所有启用的资源源。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `q` | string | 是 | 搜索关键词 |

- 无 `q`：返回 `{ results: [] }`。
- 有 `q`：并行调用所有未禁用源的 `searchFromApi(site, q)`，扁平化结果。
- 若 `DisableYellowFilter` 为 false，按 `type_name` 过滤 `yellowWords`。
- 返回：`{ results: SearchResult[] }`；失败 `500 { error: '搜索失败' }`。

### GET `/api/search/one`（OrionTV 兼容）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `q` | string | 是 | 搜索关键词 |
| `resourceId` | string | 是 | 源 key |

- 在指定源中搜索，仅保留 `title === q` 的结果。
- 返回 `{ results: SearchResult[] }`；无结果时 `404 { error: '未找到结果', result: null }`。

### GET `/api/search/resources`（OrionTV 兼容）

- 无参数，返回所有启用源列表（`ApiSite[]`）。

---

## 2. 详情类

### GET `/api/detail`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 视频 ID，仅允许 `[\w-]+` |
| `source` | string | 是 | 源 key |

- 从 `getAvailableApiSites()` 中找到对应源，调用 `getDetailFromApi(apiSite, id)`。
- 返回 `SearchResult`（含 `episodes` 播放地址列表）。
- 参数缺失/非法 `400`，源不存在 `400`，异常 `500`。

---

## 3. 豆瓣类

### GET `/api/douban`

豆瓣榜单 / 分类搜索（`j/search_subjects` 接口）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `type` | `tv`\|`movie` | 是 | - | 类型 |
| `tag` | string | 是 | - | 标签，`top250` 触发 HTML 解析分支 |
| `pageSize` | number | 否 | 16 | 1-100 |
| `pageStart` | number | 否 | 0 | ≥0 |

- `tag=top250` 时抓取 `movie.douban.com/top250` 页面并用正则解析影片信息。
- 返回 `DoubanResult { code, message, list: DoubanItem[] }`。

### GET `/api/douban/categories`

豆瓣分类（rexxar `recent_hot` 接口）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `kind` | `tv`\|`movie` | 是 | movie | 大类 |
| `category` | string | 是 | - | 分类（如 `热门`） |
| `type` | string | 是 | - | 类型 |
| `limit` | number | 否 | 20 | 1-100 |
| `start` | number | 否 | 0 | ≥0 |

- 目标地址：`https://m.douban.com/rexxar/api/v2/subject/recent_hot/{kind}?start&limit&category&type`
- 返回 `DoubanResult`。

---

## 4. 认证类

### POST `/api/login`

- **localstorage 模式**：body `{ password }`。未配置 `PASSWORD` 直接放行并清 Cookie；否则比对 `PASSWORD`，成功写入含 `password` 的 Cookie。
- **数据库模式**：body `{ username, password }`。
  - 站长（`username===USERNAME && password===PASSWORD`）→ role `owner`。
  - 用户被封禁 → `401 { error: '用户被封禁' }`。
  - `db.verifyUser` 校验 → 签发含 `signature` 的 Cookie。
- 成功 `{ ok: true }`，失败 `401 { error }`。

### POST `/api/register`

- localstorage 模式直接返回 `400 { error: '当前模式不支持注册' }`。
- 未开放注册（`AllowRegister=false`）→ `400`。
- 用户名与站长重复/已存在 → `400`。
- 成功：`db.registerUser` + 写入 `UserConfig.Users` + 保存配置 + 签发 Cookie。

### POST `/api/logout`

- 清除 `auth` Cookie，返回 `{ ok: true }`。

### POST `/api/change-password`

- localstorage 模式不支持（`400`）。
- body `{ newPassword }`；需登录（Cookie 中有 `username`）。
- 站长不可通过此接口改密（`403`），需用 `/api/admin/user` 的 `changePassword`。
- 调用 `storage.changePassword(username, newPassword)`。

### GET `/api/server-config`（白名单）

- 返回 `{ SiteName, StorageType }`，供客户端判断。

---

## 5. 用户数据类

> 以下接口均需登录，从 Cookie 取 `username`；`key` 采用 `source+id` 格式。

### `/api/favorites`

| 方法 | 参数 | 说明 |
| --- | --- | --- |
| GET | 无 | 返回全部收藏 `Record<string, Favorite>` |
| GET | `key` | 返回单条 `Favorite \| null` |
| POST | body `{ key, favorite }` | 保存收藏（补全 `save_time`） |
| DELETE | 无 | 清空全部收藏 |
| DELETE | `key` | 删除单条收藏 |

### `/api/playrecords`

| 方法 | 参数 | 说明 |
| --- | --- | --- |
| GET | 无 | 返回全部播放记录 `Record<string, PlayRecord>` |
| POST | body `{ key, record }` | 保存记录（校验 `title/source_name/index`，补全 `save_time`） |
| DELETE | 无 | 清空全部记录（遍历删除） |
| DELETE | `key` | 删除单条记录 |

### `/api/searchhistory`

| 方法 | 参数 | 说明 |
| --- | --- | --- |
| GET | 无 | 返回 `string[]`（≤20 条） |
| POST | body `{ keyword }` | 去重后插入队首，返回最新列表 |
| DELETE | 无 | 清空 |
| DELETE | `keyword` | 删除单条 |

### `/api/skipconfigs`

| 方法 | 参数 | 说明 |
| --- | --- | --- |
| GET | `source`+`id` | 返回单条 `SkipConfig` |
| GET | 无 | 返回全部 `Record<string, SkipConfig>` |
| POST | body `{ key, config }` | 保存（`enable` 布尔、`intro_time`/`outro_time` 数字） |
| DELETE | `key` | 删除单条 |

---

## 6. 管理类

> 仅非 localstorage 部署可用；需 owner（站长）或 admin 角色（**D1 下同样可用**）。
> `owner` = 用户名等于 `process.env.USERNAME`；`admin` = 配置中 `role === 'admin'`。

### GET `/api/admin/config`

- 返回 `AdminConfigResult { Role: 'owner'|'admin', Config: AdminConfig }`。
- 非管理员 `401 { error: '你是管理员吗你就访问？' }`。

### POST `/api/admin/site`

更新站点设置，body：

```json
{
  "SiteName": "string",
  "Announcement": "string",
  "SearchDownstreamMaxPage": 5,
  "SiteInterfaceCacheTime": 7200,
  "ImageProxy": "string",
  "DoubanProxy": "string",
  "DisableYellowFilter": false
}
```

> 这些字段均写入数据库并即时生效（数据库为权威来源）。

### POST `/api/admin/source`

视频源管理。`action` ∈ `add | disable | enable | delete | sort`

| action | 参数 | 说明 |
| --- | --- | --- |
| `add` | `key,name,api,detail?` | 新增自定义源（`from: 'custom'`） |
| `disable` / `enable` | `key` | 启停源 |
| `delete` | `key` | 删除源（`from: 'config'` 的不可删除） |
| `sort` | `order: string[]` | 按 key 顺序重排 |

### POST `/api/admin/category`

自定义分类管理。`action` ∈ `add | disable | enable | delete | sort`

- `add` 参数：`name, type('movie'|'tv'), query`；以 `query+type` 为唯一标识。
- `delete`：`from: 'config'` 的分类不可删除。
- 本版本已**放开 D1/Upstash 限制**，各存储模式下均可管理（此前版本在 D1/Upstash 下会返回 `400`）。

### POST `/api/admin/user`

用户管理。`action` ∈ `add | ban | unban | setAdmin | cancelAdmin | setAllowRegister | changePassword | deleteUser`

| action | 参数 | 说明 |
| --- | --- | --- |
| `add` | `targetUsername,targetPassword` | 新增用户 |
| `ban`/`unban` | `targetUsername` | 封禁/解封（封禁管理员需 owner） |
| `setAdmin`/`cancelAdmin` | `targetUsername` | 设置/取消管理员（仅 owner） |
| `setAllowRegister` | `allowRegister` | 开关注册 |
| `changePassword` | `targetUsername,targetPassword` | 改密（不可改站长） |
| `deleteUser` | `targetUsername` | 删除用户（级联删除其数据） |

权限要点：不可操作站长；管理员只能操作普通用户；不能删除自己；不能对自己进行 add/ban/setAdmin/delete 等操作。

### GET `/api/admin/reset`

- 仅 owner 可调用，重置配置为 `config.json` + 环境变量的默认值。

---

## 7. 其他

### GET `/api/image-proxy`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 目标图片地址（URL 编码） |

- 携带 `Referer: https://movie.douban.com/` 与 UA 抓取，原样透传图片流。
- 缓存 `max-age=15720000`（约半年）。
- 主要用于豆瓣图片防盗链绕过。

### GET `/api/cron`（白名单）

- 触发 `refreshRecordAndFavorites()`：
  - localstorage 模式直接跳过。
  - 遍历所有用户（含站长），对每条播放记录/收藏重新拉取详情，当**总集数发生变化**时更新记录。
  - 使用 `Map` 做函数级详情缓存，避免重复请求。
- 返回 `{ success, message, timestamp }`。

## 8. 相关文档

- [02-架构与数据流](./02-架构与数据流.md)
- [05-存储层与数据模型](./05-存储层与数据模型.md)
- [06-核心功能实现](./06-核心功能实现.md)
