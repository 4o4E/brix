// brix 内置脚本：引导用户在 brix profile 内登录知乎
//
// 执行入口：POST /sessions/:sid/scripts/zhihu-login
//
// 行为：打开 zhihu.com/signin，轮询登录状态。
//   一旦检测到登录完成（页面头部出现头像 / z_c0 cookie / 离开 signin 页）就返回。
//   最长等 10 分钟。
//
// cookie 留在 USER_DATA_DIR，下次 newTab（含 zhihu 抓取脚本）自动复用。
//
// 注意：知乎对“看起来像自动化的 Chrome”有风控（扫码 / 滑块验证可能更敏感）。
//   若本脚本里登录被反复拦截，改用 `npm run open-profile -- https://www.zhihu.com/signin`
//   ——那是完全不带 CDP / automation flag 的纯净 Chrome，更不容易触发风控；
//   登录后关窗口，再 `npm run serve`，登录态同样落在 profile 里。

import type { Page } from 'patchright';
import type { Run } from '../src/runs/run.js';

export const meta = {
  description: '打开知乎登录页，等用户在浏览器里完成登录后返回（cookie 留在 profile）',
  argsExample: {},
};

export interface ZhihuLoginOutput {
  loggedIn: boolean;
  finalUrl: string;
  durationMs: number;
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    // 已登录的关键 cookie（非 httpOnly 时可读到）
    const cookies = await page.context().cookies('https://www.zhihu.com').catch(() => []);
    if (cookies.some((c) => c.name === 'z_c0' && c.value)) return true;
  } catch { /* 某些环境 context().cookies 不可用，退回 DOM 判断 */ }
  try {
    return await page.evaluate(() => {
      if (/\bz_c0=/.test(document.cookie)) return true;
      return !!document.querySelector(
        '.AppHeader-profileAvatar, [class*="AppHeader-profile"], img.Avatar.AppHeader-profileAvatar',
      );
    });
  } catch { return false; }
}

export async function runInSession(page: Page, _args: unknown, run: Run): Promise<ZhihuLoginOutput> {
  const t0 = Date.now();
  const maxMs = 600_000;

  run.log.info('opening zhihu.com/signin');
  await page.goto('https://www.zhihu.com/signin', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  run.log.info('已打开知乎登录页 — 请在浏览器内完成登录（扫码 / 短信 / 密码均可，最多等 10 分钟）');

  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await isLoggedIn(page)) {
      const out: ZhihuLoginOutput = { loggedIn: true, finalUrl: page.url(), durationMs: Date.now() - t0 };
      run.log.info(`已登录知乎 (${out.finalUrl}) in ${out.durationMs}ms`);
      return out;
    }
    await page.waitForTimeout(2_000);
  }

  run.log.warn(`登录等待超时（${maxMs}ms），返回 loggedIn=false`);
  return { loggedIn: false, finalUrl: page.url(), durationMs: Date.now() - t0 };
}
