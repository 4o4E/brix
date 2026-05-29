// HTTP 路由共用工具：JSON 响应、错误响应、body 读取
//
// 不用任何 web 框架，直接基于 node:http。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getEnv } from '../config.js';

// body 上限走 env（BRIX_HTTP_MAX_BODY_MB，默认 64MB）。脚本里传 base64 图片是大头：
// 一张 ~15MB 的手机原图 base64 后 ~20MB，再加 JSON 包装容易撞 4MB 旧限。
// 这里不缓存常量值 —— getEnv() 是 cached singleton，每次调用零开销，
// 但测试可以在 import 顺序固定的前提下覆盖 env。

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

export function sendError(res: ServerResponse, status: number, error: string, details?: string): void {
  sendJson(res, status, details ? { error, details } : { error });
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const max = getEnv().HTTP_MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > max) throw new Error('body too large');
    chunks.push(buf);
  }
  if (total === 0) return null;
  const text = Buffer.concat(chunks).toString('utf-8');
  try { return JSON.parse(text) as T; } catch { throw new Error('invalid json body'); }
}
