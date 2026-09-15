/**
 * 自定义 Worker 入口。
 *
 * OpenNext 生成的 `.open-next/worker.js` 只导出 fetch，无法响应 Cloudflare
 * Cron Triggers（定时触发器只调用 scheduled）。这里在其之上包一层：
 * - fetch：原样转发给 OpenNext 生成的 Worker；
 * - scheduled：定时触发时请求内部接口，由 Next 运行时执行实际任务。
 *
 * 注意：
 * 1. `.open-next/` 是构建产物，不要直接修改，每次 `npm run build:worker` 会重新生成；
 * 2. 目录不能叫 `worker`，否则会被 next-pwa 当作前端自定义 Service Worker 打包。
 */

// @ts-expect-error 构建产物，无类型声明
import openNextWorker from '../.open-next/worker.js';

// @ts-expect-error 构建产物，无类型声明
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from '../.open-next/worker.js';

/** 定时任务目标地址，可通过 CRON_TARGET_URL 覆盖 */
const DEFAULT_CRON_URL = 'https://mytvapp.qzz.io/api/cron';

interface ScheduledEnv {
  CRON_TARGET_URL?: string;
}

export default {
  async fetch(
    request: Request,
    env: unknown,
    ctx: ExecutionContext
  ): Promise<Response> {
    return openNextWorker.fetch(request, env, ctx);
  },

  async scheduled(
    _controller: unknown,
    env: ScheduledEnv,
    ctx: ExecutionContext
  ): Promise<void> {
    const url = env?.CRON_TARGET_URL || DEFAULT_CRON_URL;
    console.log('[cron] scheduled triggered:', new Date().toISOString(), url);
    ctx.waitUntil(
      fetch(url, { method: 'GET' })
        .then((res) => {
          console.log('[cron] response status:', res.status);
        })
        .catch((err) => {
          console.error('[cron] request failed:', err);
        })
    );
  },
};
