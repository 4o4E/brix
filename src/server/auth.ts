// HTTP 鉴权：constant-time 校验 token。
//
// 启动时若 BRIX_TOKEN 为空，serve.ts 会拒启 —— 这里不做 null 处理，假定 token 始终非空。

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auth');

function extractToken(req: IncomingMessage): string | null {
  const xb = req.headers['x-brix-token'];
  if (typeof xb === 'string' && xb.length > 0) return xb;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (m) return m[1];
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function checkAuth(req: IncomingMessage, expected: string): boolean {
  const got = extractToken(req);
  if (!got) {
    log.warn(`auth fail from ${req.socket.remoteAddress} path=${req.url} reason=no-token`);
    return false;
  }
  if (!safeEqual(got, expected)) {
    log.warn(`auth fail from ${req.socket.remoteAddress} path=${req.url} reason=mismatch`);
    return false;
  }
  return true;
}
