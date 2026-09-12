# WorkerMoonTV 项目分析文档

本目录是对 [WorkerMoonTV](../README.md)（**影视聚合播放器 · Cloudflare Workers 版**）源码的分析文档，面向希望二次开发、部署或了解其内部实现的开发者。

> WorkerMoonTV 基于开源项目 MoonTV 改造而来，将原本的 Next.js 站点适配为 **Cloudflare Workers** 应用（使用官方推荐的 OpenNext Cloudflare 适配器），数据默认存储在 **Cloudflare D1**。

## 文档索引

| 文档 | 内容简介 |
| --- | --- |
| [01-项目概述](./01-项目概述.md) | 项目简介、核心功能、技术栈、目录总览、存储/部署、环境变量与绑定 |
| [02-架构与数据流](./02-架构与数据流.md) | 分层架构、配置体系与优先级、鉴权流程、搜索/播放/豆瓣/管理数据流、客户端同步、Workers 运行时 |
| [03-目录结构与模块说明](./03-目录结构与模块说明.md) | 根目录、scripts、app 页面与 API、lib、components、public 逐项说明 |
| [04-API接口文档](./04-API接口文档.md) | 所有 `/api/*` 接口的参数、请求体、返回值、鉴权与缓存约定 |
| [05-存储层与数据模型](./05-存储层与数据模型.md) | IStorage 接口、数据模型、D1/Redis/Upstash/localstorage 的表结构与 Key |
| [06-核心功能实现](./06-核心功能实现.md) | 聚合搜索、播放器（ArtPlayer/HLS）、去广告、跳过片头片尾、播放记录、豆瓣、收藏、缓存订阅、管理后台、PWA |
| [07-部署与运维](./07-部署与运维.md) | 本地开发、构建脚本、Cloudflare Workers 部署、D1 初始化、定时任务、调优与排障、安全建议 |

## 快速上手

```bash
npm install

npm run dev            # 本地开发（自动生成 runtime/manifest 后启动 next dev）
npm run build:worker   # 构建 Cloudflare Workers 产物（输出到 .open-next/）
npx wrangler deploy    # 部署到 Cloudflare Workers
```

## 阅读建议

- 想了解**整体设计** → 先读 [01](./01-项目概述.md)、[02](./02-架构与数据流.md)。
- 想**对接/调试接口** → 读 [04](./04-API接口文档.md)。
- 想**换存储 / 迁移数据** → 读 [05](./05-存储层与数据模型.md)。
- 想**改播放器 / 搜索** → 读 [06](./06-核心功能实现.md)。
- 准备**上线 / 排障** → 读 [07](./07-部署与运维.md)。

> 说明：本目录文档基于当前仓库源码整理，如源码更新请以实际代码为准。
