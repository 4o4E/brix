// brix CLI 客户端共用 helper：scripts/<name>.ts 通过 HTTP 触发 server 上的同名脚本
//
// 一次调用 = 4 个 HTTP 请求：
//   POST /sessions                            创建会话
//   POST /sessions/:sid/scripts/:name         同步执行脚本
//   GET  /runs/:rid/files/:name * N           把 downloads 抓回本地
//   DELETE /sessions/:sid                     清理会话（finally 里 best-effort）
//
// CLI 复用 server 的 env：BRIX_TOKEN / BRIX_HTTP_HOST / BRIX_HTTP_PORT。
//   - 没 token → throw（CLI 没法工作）
//   - HTTP_HOST 是 0.0.0.0 时连 127.0.0.1（0.0.0.0 是 listen 的语义，连接得用具体地址）

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getEnv } from '../config.js';

export interface CliOpts {
  /** 文件输出目录，默认 ./out/<runId>/ */
  out?: string;
  /** 创建 session 时的 initial url */
  url?: string;
}

export interface CliResult {
  runId: string;
  output: unknown;
  savedFiles: string[];
}

function baseUrl(): string {
  const env = getEnv();
  const host = env.HTTP_HOST === '0.0.0.0' ? '127.0.0.1' : env.HTTP_HOST;
  return `http://${host}:${env.HTTP_PORT}`;
}

function authHeaders(): Record<string, string> {
  const env = getEnv();
  if (!env.HTTP_TOKEN) throw new Error('BRIX_TOKEN env required for CLI client');
  return {
    Authorization: `Bearer ${env.HTTP_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function readJsonOr<T>(res: Response, fallback: T): Promise<T> {
  try { return await res.json() as T; } catch { return fallback; }
}

export async function runViaBrix(scriptName: string, args: unknown, opts: CliOpts = {}): Promise<CliResult> {
  const base = baseUrl();
  const headers = authHeaders();

  // 1) 创建 session
  const sRes = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.url ? { url: opts.url } : {}),
  });
  if (!sRes.ok) throw new Error(`create session failed: ${sRes.status} ${await sRes.text()}`);
  const sBody = await sRes.json() as { sessionId?: string };
  if (!sBody.sessionId) throw new Error(`create session: no sessionId in response: ${JSON.stringify(sBody)}`);
  const sessionId = sBody.sessionId;

  try {
    // 2) 跑脚本
    const rRes = await fetch(`${base}/sessions/${sessionId}/scripts/${scriptName}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ args }),
    });
    const rBody = await readJsonOr<{ runId?: string; output?: unknown; downloads?: Array<{ name: string }>; error?: string }>(rRes, {});
    if (!rRes.ok) {
      throw new Error(`run ${scriptName} failed: ${rRes.status} ${JSON.stringify(rBody)}`);
    }
    if (!rBody.runId) {
      throw new Error(`run ${scriptName}: no runId in response: ${JSON.stringify(rBody)}`);
    }
    const runId = rBody.runId;
    const downloads = Array.isArray(rBody.downloads) ? rBody.downloads : [];

    // 3) 抓 downloads 到 out 目录
    const outDir = opts.out ?? join('out', runId);
    await mkdir(outDir, { recursive: true });
    const saved: string[] = [];
    for (const f of downloads) {
      const fRes = await fetch(`${base}/runs/${runId}/files/${encodeURIComponent(f.name)}`, { headers: { Authorization: headers.Authorization } });
      if (!fRes.ok) {
        console.error(`fetch ${f.name} failed: ${fRes.status}`);
        continue;
      }
      const buf = Buffer.from(await fRes.arrayBuffer());
      const p = join(outDir, f.name);
      await writeFile(p, buf);
      saved.push(p);
    }

    return { runId, output: rBody.output, savedFiles: saved };
  } finally {
    // 4) 关 session（best-effort，不挡报错路径）
    await fetch(`${base}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: headers.Authorization },
    }).catch(() => { /* ignore */ });
  }
}
