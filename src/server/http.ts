// brix HTTP 服务：listen + 鉴权中间件 + 路由分发
//
// 端点划分：
//   /health                                  公开
//   /scripts/...                             需要 token
//   /runs/.../files...                       需要 token
//   /sessions/...                            需要 token
//   /mcp                                     需要 token，标准 MCP Streamable HTTP endpoint

import { createServer as createHttpServer, type Server } from 'node:http';
import { URL } from 'node:url';
import { getEnv } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { checkAuth } from './auth.js';
import { handleFiles } from './routes/files.js';
import { handleMcp } from './routes/mcp.js';
import { handleScripts } from './routes/scripts.js';
import { handleSessions } from './routes/sessions.js';
import { sendError, sendJson } from './util.js';

const log = createLogger('http');

export function createServer(): Server {
  const env = getEnv();
  if (!env.HTTP_TOKEN) {
    throw new Error('BRIX_TOKEN must be set, refusing to start');
  }
  const token = env.HTTP_TOKEN;

  return createHttpServer(async (req, res) => {
    const t0 = Date.now();
    const method = req.method ?? 'GET';
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch { /* fallthrough */ }

    res.on('finish', () => {
      log.info(`${method} ${pathname} → ${res.statusCode} ${Date.now() - t0}ms`);
    });

    try {
      // 公开端点
      if (pathname === '/health' && method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // 鉴权
      if (!checkAuth(req, token)) {
        sendError(res, 403, 'forbidden');
        return;
      }

      // 分发
      if (pathname.startsWith('/runs/')) {
        if (await handleFiles(req, res, pathname)) return;
      }
      if (pathname === '/scripts' || pathname.startsWith('/scripts/')) {
        if (await handleScripts(req, res, pathname)) return;
      }
      if (pathname === '/sessions' || pathname.startsWith('/sessions/')) {
        if (await handleSessions(req, res, pathname)) return;
      }
      if (pathname === '/mcp') {
        if (await handleMcp(req, res, pathname)) return;
      }

      sendError(res, 404, 'not_found');
    } catch (e) {
      log.error(`unhandled: ${e instanceof Error ? e.stack ?? e.message : e}`);
      if (!res.headersSent) sendError(res, 500, 'internal');
    }
  });
}
