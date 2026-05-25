// 集成测试共用：起一个未 listen 的 server，listen(0) 拿随机端口，封一些 fetch helper。
//
// 注意 env 设置时机：node:test 一个进程里跑所有 .test.ts 文件，
// config.ts 的 getEnv() 用模块级 cached 单例 —— 第一次调用即冻结。
// 所以 BRIX_TOKEN 等必须在任何路由代码触达 getEnv() 之前 set 好。
// 测试文件应在 *module top-level* 调用 setupTestEnv() 而不是 before()，
// 这样 import 阶段就完成，确保比所有 before() / test() 都早。

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

export const TEST_TOKEN = 'test-token-integration-xyz';

export interface TestDirs {
  dataDir: string;
  scriptsDir: string;
  userDataDir: string;
}

/**
 * Top-level setup: 同步建 tmp 目录、写 process.env。
 * 安全可重复调用（每次回到同一 cached 值 —— 第一次写入后 env 已固定）。
 * 返回本进程内被 cached 的 dataDir/scriptsDir（注意：跨测试文件第一个调用的胜出）。
 */
export function setupTestEnv(label: string): TestDirs {
  // 之所以用 sync API：必须在模块顶层完成，不能 await。
  const root = mkdtempSync(join(tmpdir(), `brix-itest-${label}-`));
  const dataDir = join(root, 'data');
  const scriptsDir = join(root, 'scripts');
  const userDataDir = join(root, 'user-data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });

  // node:test 默认每个 test file 一个独立 process，所以可以放心 force-override。
  // 必须 force：dotenv 在 config.ts import 时已经把 .env 里的真 token 装进 process.env，
  // 我们要把它替换成测试 token，否则 authFetch 全部 403。
  process.env.BRIX_TOKEN = TEST_TOKEN;
  process.env.BRIX_DATA_DIR = dataDir;
  process.env.BRIX_SCRIPTS_DIR = scriptsDir;
  process.env.BRIX_USER_DATA_DIR = userDataDir;
  process.env.BRIX_LOG_LEVEL = 'error';

  return {
    dataDir: process.env.BRIX_DATA_DIR!,
    scriptsDir: process.env.BRIX_SCRIPTS_DIR!,
    userDataDir: process.env.BRIX_USER_DATA_DIR!,
  };
}

/** 起一个 http.Server 在随机端口 listen，返回 base URL + close fn */
export async function startTestServer(server: Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 简短 helper：authorized fetch */
export function authFetch(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

export function rawFetch(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}
