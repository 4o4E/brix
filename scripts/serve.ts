// brix HTTP 服务入口
//
// 用法：
//   BRIX_TOKEN=<token> npm run serve
//
// 可选 env：
//   BRIX_HTTP_HOST   默认 0.0.0.0
//   BRIX_HTTP_PORT   默认 9233

import { getEnv } from '../src/config.js';
import { createServer } from '../src/server/http.js';
import { browserEvents, closeSession } from '../src/browser/session.js';
import { createLogger } from '../src/utils/logger.js';
import { syncBuiltins } from '../src/scripts/bootstrap.js';

const log = createLogger('serve');

async function main() {
  const env = getEnv();
  if (!env.HTTP_TOKEN) {
    console.error('BRIX_TOKEN must be set, refusing to start');
    process.exit(1);
  }

  // 把内置脚本拷到 SCRIPTS_DIR；失败不致命，HTTP 仍然可响应 CRUD
  try { await syncBuiltins(); } catch (e) { log.warn(`syncBuiltins failed: ${e instanceof Error ? e.message : e}`); }

  const server = createServer();
  server.listen(env.HTTP_PORT, env.HTTP_HOST, () => {
    log.info(`brix http on http://${env.HTTP_HOST}:${env.HTTP_PORT}`);
    console.log(`brix http on http://${env.HTTP_HOST}:${env.HTTP_PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`got ${sig}, shutting down`);
    await new Promise<void>((res) => server.close(() => res()));
    await closeSession().catch(() => { /* ignore */ });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 用户/外部关掉了 Chrome（关窗口、taskkill 等）→ brix 也跟着退
  // 与 idle 超时 (closeSession) 不同：idle 超时是我们主动 disconnect，不会触发这条路径
  browserEvents.on('user-closed', () => {
    log.warn('chrome closed by user/external, shutting down brix');
    void shutdown('browser-closed');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
