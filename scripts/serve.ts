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
import { closeSession } from '../src/browser/session.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('serve');

async function main() {
  const env = getEnv();
  if (!env.HTTP_TOKEN) {
    console.error('BRIX_TOKEN must be set, refusing to start');
    process.exit(1);
  }

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
