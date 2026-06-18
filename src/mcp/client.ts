// MCP server → brix HTTP 的薄客户端。
//
// MCP server 只是 brix 的又一个 HTTP 调用方：复用 brix 的 env（BRIX_API_URL 优先连远端，
// 否则按 server 绑定地址推导；BRIX_TOKEN 鉴权）。所有 tool 都经这里发请求，不直接碰浏览器。

import { getEnv } from '../config.js';

export class BrixHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'BrixHttpError';
  }
}

function baseUrl(): string {
  const env = getEnv();
  // 优先客户端专属 BRIX_API_URL（可指远端 brix）；否则按 server 绑定地址推导。
  if (env.API_URL) return env.API_URL;
  const host = env.HTTP_HOST === '0.0.0.0' ? '127.0.0.1' : env.HTTP_HOST;
  return `http://${host}:${env.HTTP_PORT}`;
}

function authHeader(): string {
  const t = getEnv().HTTP_TOKEN;
  if (!t) throw new Error('BRIX_TOKEN env required for brix MCP server');
  return `Bearer ${t}`;
}

/** 发一个 brix 请求，返回原始 Response（文件下载等二进制场景用）。 */
export async function brixFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', authHeader());
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${baseUrl()}${path}`, { ...init, headers });
}

/** 发一个 brix 请求并解析 JSON；非 2xx 抛 BrixHttpError（带后端 error/details）。 */
export async function brixJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await brixFetch(path, init);
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!res.ok) {
    const detail = body && typeof body === 'object' ? JSON.stringify(body) : String(body ?? res.statusText);
    throw new BrixHttpError(res.status, detail);
  }
  return body as T;
}

/** POST application/json 便捷封装。 */
export function brixPost<T = unknown>(path: string, payload: unknown): Promise<T> {
  return brixJson<T>(path, { method: 'POST', body: JSON.stringify(payload ?? {}) });
}
