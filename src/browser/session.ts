// brix 浏览器会话：通过 CDP 连接 launcher 拉起的本地 Chrome
// 移植自 my-claw src/browser/session.ts，按 brix 决策简化：
//   - 不做 tab 切换 / subagent 分配
//   - tab 模型：单 active page + newTab() 开新页（新页变 active）

import { chromium, type Browser, type BrowserContext, type Page } from 'rebrowser-playwright';
import { ensureChromeRunning } from './launcher.js';
import { getEnv } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('browser');

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let pages: Page[] = [];
let activePageIndex = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// 全局兜底：捕获 Playwright 内部未处理异常（Frame detached 等），防止进程崩溃
process.on('uncaughtException', (err) => {
  const msg = err?.message ?? String(err);
  if (msg.includes('Frame has been detached') || msg.includes('Execution context was destroyed')) {
    log.warn(`suppressed Playwright internal error: ${msg}`);
    return;
  }
  throw err;
});

async function configurePage(page: Page): Promise<void> {
  // 不再调用 Page.setDownloadBehavior — Playwright connectOverCDP 自己管下载临时目录，
  // 覆盖 downloadPath 会让 download.saveAs 找不到文件。脚本需要落地下载时自己监听
  // page.on('download') 并 saveAs(runDir/...) 即可。
  page.on('crash', () => log.warn(`page crashed: ${page.url()}`));
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  const minutes = getEnv().IDLE_TIMEOUT_MIN;
  if (minutes <= 0) return;
  idleTimer = setTimeout(() => {
    void closeSession();
  }, minutes * 60 * 1000);
}

function isPageAlive(page: Page): boolean {
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

function resetState(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (browser) browser.close().catch(() => { /* ignore */ });
  browser = null;
  context = null;
  pages = [];
  activePageIndex = 0;
}

/** 确保有可用 page，必要时连接 Chrome / 复活 page。返回当前 active page。 */
export async function ensurePage(): Promise<Page> {
  // 连接挂了就重置
  if (browser && !browser.isConnected()) {
    log.warn('browser disconnected, resetting');
    resetState();
  }

  // 已连接但当前 active page 死了：清死页，必要时新建
  if (browser && pages.length > 0) {
    const current = pages[activePageIndex];
    if (!current || !isPageAlive(current)) {
      log.warn('active page closed, cleaning stale pages');
      pages = pages.filter(isPageAlive);
      if (pages.length === 0 && context) {
        try {
          pages = context.pages().filter(isPageAlive);
        } catch {
          log.warn('context broken, full reconnect');
          resetState();
        }
      }
      if (pages.length === 0 && browser?.isConnected()) {
        try {
          if (!context) {
            const ctxs = browser!.contexts();
            context = ctxs.length > 0 ? ctxs[0] : await browser!.newContext({ locale: 'zh-CN', acceptDownloads: true });
          }
          pages = [await context.newPage()];
          await configurePage(pages[0]);
          log.info('created new page after stale cleanup');
        } catch (err) {
          log.warn('failed to create new page, full reconnect:', err instanceof Error ? err.message : err);
          resetState();
        }
      }
      activePageIndex = Math.max(0, Math.min(activePageIndex, pages.length - 1));
    }
  }

  // 还没连接 → spawn Chrome + connect
  if (!browser || !browser.isConnected()) {
    const wsUrl = await ensureChromeRunning();
    log.info(`connectOverCDP ${wsUrl}`);
    browser = await chromium.connectOverCDP(wsUrl, { timeout: 10_000 });

    browser.on('disconnected', () => {
      log.warn('browser disconnected event');
      resetState();
    });

    // 优先复用已有 context（避免覆盖 cookies / 用户首选项）
    const ctxs = browser.contexts();
    if (ctxs.length > 0) {
      context = ctxs[0];
      pages = context.pages().filter(isPageAlive);
      if (pages.length === 0) pages = [await context.newPage()];
    } else {
      context = await browser.newContext({ locale: 'zh-CN', acceptDownloads: true });
      pages = [await context.newPage()];
    }
    activePageIndex = pages.length - 1;
    for (const p of pages) await configurePage(p);
    log.info(`connected, ${pages.length} page(s)`);
  }

  resetIdleTimer();
  return pages[activePageIndex];
}

/** 开新 tab，新 tab 变 active。可选地直接导航到 url。 */
export async function newTab(url?: string): Promise<Page> {
  await ensurePage(); // 确保有连接
  if (!context) throw new Error('browser context not ready');
  const page = await context.newPage();
  await configurePage(page);
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => {
      log.warn(`newTab goto failed: ${e instanceof Error ? e.message : e}`);
    });
  }
  pages.push(page);
  activePageIndex = pages.length - 1;
  resetIdleTimer();
  return page;
}

/** 当前 active page（不自动连接） */
export function getActivePage(): Page | null {
  const page = pages[activePageIndex] ?? null;
  if (page && !isPageAlive(page)) return null;
  return page;
}

/** 断开 Playwright 连接（不关 Chrome 进程） */
export async function closeSession(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (browser) {
    await browser.close().catch(() => { /* ignore */ });
    browser = null;
    context = null;
    pages = [];
    activePageIndex = 0;
    log.info('disconnected');
  }
}

export function isSessionActive(): boolean {
  return browser !== null && browser.isConnected();
}

/** 内部获取浏览器对象（脚本一般不需要） */
export function getBrowser(): Browser | null {
  return browser;
}
