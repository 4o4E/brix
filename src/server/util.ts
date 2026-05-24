// HTTP 路由共用工具：JSON 响应、错误响应、body 读取
//
// 不用任何 web 框架，直接基于 node:http。

import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY = 4 * 1024 * 1024;  // 4 MB；脚本源码上限是 1MB，留余量给 base64 等

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
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY) throw new Error('body too large');
    chunks.push(buf);
  }
  if (total === 0) return null;
  const text = Buffer.concat(chunks).toString('utf-8');
  try { return JSON.parse(text) as T; } catch { throw new Error('invalid json body'); }
}
