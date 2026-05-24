// 浏览器交互原语：导航、点击、填写、滚动等
// 操作完成后自动返回最新 snapshot，方便链式调用
// 移植自 my-claw src/browser/agent.ts

import type { ElementHandle, Page } from 'rebrowser-playwright';
import { ensurePage } from './session.js';
import {
  takeSnapshot,
  getDefaultRefContext,
  type BrowserRefContext,
} from './snapshot.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('browser');

async function getElementByRef(
  page: Page,
  ref: string,
  ctx?: BrowserRefContext,
): Promise<ElementHandle> {
  const c = ctx ?? getDefaultRefContext();
  const entry = c.refMap.get(ref);
  if (!entry) throw new Error(`ref "${ref}" 不存在，请先调用 snapshot 获取最新页面结构`);

  if (entry.selector) {
    const el = await page.$(entry.selector);
    if (el) return el;
  }
  if (entry.name) {
    try {
      const locator = page.getByRole(entry.role as Parameters<Page['getByRole']>[0], { name: entry.name });
      const el = await locator.elementHandle({ timeout: 3000 });
      if (el) return el;
    } catch { /* fall through */ }
  }
  throw new Error(`无法定位元素 ref=${ref} (${entry.role} "${entry.name}" selector="${entry.selector}")`);
}

/** 导航到 URL，等 domcontentloaded，返回 { title, snapshot } */
export async function navigate(
  url: string,
  page?: Page,
  ctx?: BrowserRefContext,
): Promise<{ title: string; snapshot: string }> {
  const p = page ?? (await ensurePage());
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 某些站点（如 Google 部分页面）会通过 COOP 等头阻断 CDP 浏览器，
    // 此时页面可能已经部分加载，尝试继续 snapshot
    if (msg.includes('ERR_BLOCKED_BY_RESPONSE') || msg.includes('ERR_ABORTED')) {
      log.warn(`navigate partial: ${msg}`);
      await p.waitForTimeout(1000).catch(() => { /* ignore */ });
    } else {
      throw err;
    }
  }
  let title = '';
  let snap = '';
  try {
    title = await p.title();
    snap = await takeSnapshot(p, undefined, ctx);
  } catch {
    title = url;
    snap = `(页面加载失败或被阻止: ${url})`;
  }
  return { title, snapshot: snap };
}

/** 直接取当前页 snapshot */
export async function snapshot(page?: Page, ctx?: BrowserRefContext): Promise<string> {
  const p = page ?? (await ensurePage());
  return await takeSnapshot(p, undefined, ctx);
}

/** 截图 */
export async function screenshot(fullPage = false, page?: Page): Promise<Buffer> {
  const p = page ?? (await ensurePage());
  return await p.screenshot({ fullPage, type: 'png' });
}

/** 按 ref 点击 */
export async function click(
  ref: string,
  page?: Page,
  ctx?: BrowserRefContext,
): Promise<string> {
  const p = page ?? (await ensurePage());
  const el = await getElementByRef(p, ref, ctx);
  try {
    await el.click({ timeout: 5000 });
  } catch {
    await el.click({ force: true });
  }
  await p.waitForLoadState('domcontentloaded').catch(() => { /* ignore */ });
  return await takeSnapshot(p, undefined, ctx);
}

/** 直接按 CSS selector 点击（用于一次性 / 不走 ref 的场景） */
export async function clickSelector(
  selector: string,
  page?: Page,
  ctx?: BrowserRefContext,
): Promise<string> {
  const p = page ?? (await ensurePage());
  await p.waitForSelector(selector, { state: 'attached', timeout: 30_000 });
  await p.click(selector, { force: true, timeout: 10_000 });
  await p.waitForLoadState('domcontentloaded').catch(() => { /* ignore */ });
  return await takeSnapshot(p, undefined, ctx);
}

/** 按 ref 填写输入框 / contenteditable */
export async function fill(
  ref: string,
  value: string,
  page?: Page,
  ctx?: BrowserRefContext,
): Promise<string> {
  const p = page ?? (await ensurePage());
  const el = await getElementByRef(p, ref, ctx);
  try {
    await el.fill(value);
  } catch {
    await el.click({ force: true });
    await el.evaluate((e: unknown) => {
      const node = e as HTMLElement & { value?: string };
      node.textContent = '';
      if ('innerText' in node) node.innerText = '';
      if (node.value !== undefined) node.value = '';
    });
    await p.keyboard.type(value);
  }
  return `已填写 ref=${ref}: "${value}"`;
}

/** 直接按 CSS selector 填写 */
export async function fillSelector(
  selector: string,
  value: string,
  page?: Page,
): Promise<string> {
  const p = page ?? (await ensurePage());
  try {
    await p.fill(selector, value);
  } catch {
    await p.click(selector, { force: true });
    await p.evaluate(
      `((sel) => { const el = document.querySelector(sel); if (el) { el.textContent = ""; if ("innerText" in el) el.innerText = ""; if (el.value !== undefined) el.value = ""; } })(${JSON.stringify(selector)})`,
    );
    await p.keyboard.type(value);
  }
  return `已填写 "${selector}": "${value}"`;
}

/** 选择 select 选项 */
export async function select(
  ref: string,
  value: string,
  page?: Page,
  ctx?: BrowserRefContext,
): Promise<string> {
  const p = page ?? (await ensurePage());
  const c = ctx ?? getDefaultRefContext();
  const entry = c.refMap.get(ref);
  if (!entry) throw new Error(`ref "${ref}" 不存在`);
  const locator = p.getByRole(entry.role as Parameters<Page['getByRole']>[0], { name: entry.name });
  await locator.selectOption(value);
  return `已选择 ref=${ref}: "${value}"`;
}

/** 悬停 */
export async function hover(
  ref: string,
  page?: Page,
  ctx?: BrowserRefContext,
): Promise<string> {
  const p = page ?? (await ensurePage());
  const el = await getElementByRef(p, ref, ctx);
  await el.hover();
  return await takeSnapshot(p, undefined, ctx);
}

/** 滚动 */
export async function scroll(
  direction: 'up' | 'down',
  amount = 500,
  page?: Page,
  ctx?: BrowserRefContext,
): Promise<string> {
  const p = page ?? (await ensurePage());
  await p.mouse.wheel(0, direction === 'down' ? amount : -amount);
  await p.waitForTimeout(300);
  return await takeSnapshot(p, undefined, ctx);
}

/** 按键 */
export async function pressKey(key: string, page?: Page): Promise<string> {
  const p = page ?? (await ensurePage());
  await p.keyboard.press(key);
  return `已按下 ${key}`;
}

/** 在页面中执行任意 JS（字符串形式，避免 tsx __name 包装），返回结果 */
export async function evaluate<T = unknown>(script: string, page?: Page): Promise<T> {
  const p = page ?? (await ensurePage());
  return (await p.evaluate(script)) as T;
}

/** 等待选择器出现 / 等待固定毫秒 */
export async function waitFor(
  selectorOrMs: string | number,
  page?: Page,
): Promise<string> {
  const p = page ?? (await ensurePage());
  if (typeof selectorOrMs === 'number') {
    await p.waitForTimeout(selectorOrMs);
    return `已等待 ${selectorOrMs}ms`;
  }
  await p.waitForSelector(selectorOrMs, { timeout: 10_000 });
  return `元素 "${selectorOrMs}" 已出现`;
}
