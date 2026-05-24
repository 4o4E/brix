// brix 内置脚本：引导用户在 brix profile 内登录 Google
//
// 用法（CLI）：
//   npm run login
//
// 用法（HTTP via session）：
//   POST /sessions/:sid/scripts/login
//
// 行为：
//   打开 accounts.google.com，轮询登录状态。
//   一旦检测到登录完成（导航到 myaccount.google.com 或类似 logged-in 标记）就返回。
//   最长等 10 分钟。
//
// cookie 保留在 USER_DATA_DIR 中，下次 newTab 自动复用。

import { pathToFileURL } from 'node:url';
import type { Page } from 'rebrowser-playwright';
import { createLogger } from '../src/utils/logger.js';
import { runAsCli } from '../src/runs/cli.js';
import type { Run } from '../src/runs/run.js';

const log = createLogger('login');

export const meta = {
  description: '打开 Google 登录页，等用户在浏览器里完成登录后返回',
  argsExample: {},
};

export interface LoginOutput {
  loggedIn: boolean;
  finalUrl: string;
  durationMs: number;
}

const LOGGED_IN_HOSTS = [
  'myaccount.google.com',
  'workspace.google.com',
];

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = new URL(page.url());
    if (LOGGED_IN_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) return true;
    // accounts.google.com 上有 [data-email] 等已登录指示
    const email = await page.evaluate(() => {
      const el = document.querySelector('[data-email], [data-identifier]');
      return el ? el.getAttribute('data-email') ?? el.getAttribute('data-identifier') : null;
    }).catch(() => null);
    return !!email && email.includes('@');
  } catch { return false; }
}

export async function runInSession(page: Page, _args: unknown, run: Run): Promise<LoginOutput> {
  const t0 = Date.now();
  const maxMs = 600_000;
  log.info(`runId=${run.runId} opening accounts.google.com`);

  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  log.info('已打开 accounts.google.com — 请在浏览器内完成登录（最多等 10 分钟）');

  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await isLoggedIn(page)) {
      const out: LoginOutput = { loggedIn: true, finalUrl: page.url(), durationMs: Date.now() - t0 };
      log.info(`logged in (${out.finalUrl}) in ${out.durationMs}ms`);
      return out;
    }
    await page.waitForTimeout(2_000);
  }

  log.warn(`login timeout after ${maxMs}ms, returning loggedIn=false`);
  return { loggedIn: false, finalUrl: page.url(), durationMs: Date.now() - t0 };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsCli(runInSession, {
    // 登录脚本结束后不关 tab，方便用户继续在浏览器里看
    closeTab: false,
  });
}
