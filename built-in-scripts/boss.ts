// brix 内置脚本：BOSS 直聘（求职者/geek 侧）消息记录 + 对应职位 JD 抓取
//
// 执行入口：POST /sessions/:sid/scripts/boss
//   body: { args: { mode?, maxConvos?, maxMessages?, maxScrolls?, jd?, url? } }
//
// 远端 server 的浏览器已登录 BOSS 直聘（geek 侧）。聊天列表 / 消息走 IM 异步加载。
//
// mode='explore'：把聊天页关键容器 outerHTML 落 downloads/，供本地分析 DOM。
// mode='scrape'（默认）：遍历左侧会话 → 逐条点开抓消息历史 + 顶部职位信息 →
//   点「查看职位」打开新标签页抓 JD（按职位 URL 去重缓存）。
//
// 会话列表项：.user-list-content li[role=listitem] .friend-content
//   .name-text(Boss名) / 公司 span / .base-title(Boss职务) / .last-msg-text(最后一条预览)
// 消息：ul.im-list > li.message-item(.item-myself|.item-friend|.item-system)
//   .item-time .time / .text-content / .message-card-top-title(卡片) / .hyper-link(系统)
// 职位头：.chat-position-content .position-name / .salary / .city
// 查看职位：[ka="geek_chat_job_detail"]（无 href，点击开新标签页）
//
// 产物（downloads/，CLI 拉回 ./out/<runId>/）：result.json（+ explore 时 *.html；
//   scrape 时首个 JD 落 jd-sample.html 供校验）

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'patchright';
import type { Run } from '../src/runs/run.js';

export const meta = {
  description: 'BOSS 直聘（geek 侧）消息记录 + 对应职位 JD 抓取（新标签页）',
  argsExample: { mode: 'scrape', maxConvos: 20, jd: true },
};

interface BossArgs {
  mode?: 'explore' | 'scrape';
  /** 从第几条会话开始（0 基），用于分批避开服务端 5min requestTimeout，默认 0 */
  startIndex?: number;
  /** 最多抓多少条会话，0 = 全部，默认 0 */
  maxConvos?: number;
  /** 每条会话最多抓多少条消息，默认 200 */
  maxMessages?: number;
  /** 每条会话向上滚动加载历史的次数上限，默认 6 */
  maxScrolls?: number;
  /** 是否抓「查看职位」JD（默认 true） */
  jd?: boolean;
  /** 聊天页 url，默认 geek 侧 */
  url?: string;
}

interface BossMessage {
  mid?: string;
  /** me=我(求职者) / boss=对方 / system=系统 */
  sender: 'me' | 'boss' | 'system';
  time?: string;
  /** text=纯文本 / card=卡片(简历/交换电话等) / link=系统超链 / other */
  type: 'text' | 'card' | 'link' | 'other';
  text: string;
  status?: string;
}

interface BossJob {
  positionName?: string;
  salary?: string;
  city?: string;
  /** JD 页面 URL（新标签页） */
  url?: string;
  /** JD 正文纯文本 */
  description?: string;
  /** JD 页职位标题（校验用） */
  jdTitle?: string;
  jdError?: string;
}

interface BossConversation {
  index: number;
  bossName?: string;
  company?: string;
  bossTitle?: string;
  lastMsgPreview?: string;
  job: BossJob;
  messageCount: number;
  messages: BossMessage[];
}

interface BossOutput {
  finalUrl: string;
  loggedIn: boolean;
  convoTotal: number;
  scraped: number;
  conversations: BossConversation[];
  durationMs: number;
}

const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';
const ITEM = '.user-list-content li[role="listitem"] .friend-content';

async function dump(run: Run, name: string, content: string) {
  await writeFile(join(run.downloadsDir, name), content, 'utf-8');
}

// tsx/esbuild 会给 page.evaluate 里的具名函数包一层 __name()，但页面里没这个全局，
// 会抛 "__name is not defined"。每次新文档（goto / popup）后注入一个恒等 shim。
async function injectNameShim(page: Page) {
  await page.evaluate('window.__name = window.__name || function (fn) { return fn; };').catch(() => { /* ignore */ });
}

// ──────────────────────────── explore ────────────────────────────

async function exploreMode(page: Page, run: Run, url: string): Promise<unknown> {
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => { /* ignore */ });
  await injectNameShim(page);

  let itemCount = 0;
  for (let i = 0; i < 30; i++) {
    itemCount = await page.evaluate((sel) => document.querySelectorAll(sel).length, ITEM);
    if (itemCount > 0) break;
    await page.waitForTimeout(1_000);
  }
  await dump(run, 'page.html', await page.content());
  await dump(run, 'list.html', await page.evaluate(() => document.querySelector('.user-list-content')?.outerHTML || '(none)'));

  let convoClicked = false;
  if (itemCount > 0) {
    try {
      await page.locator(ITEM).first().click({ timeout: 5_000 });
      for (let i = 0; i < 20; i++) {
        if (await page.evaluate(() => !document.querySelector('.chat-conversation .chat-no-data'))) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1_500);
      convoClicked = true;
    } catch { /* ignore */ }
  }
  await dump(run, 'convo.html', await page.evaluate(() => document.querySelector('.chat-conversation')?.outerHTML || '(none)'));

  const probe = { finalUrl: page.url(), itemCount, convoClicked };
  await dump(run, 'probe.json', JSON.stringify(probe, null, 2));
  run.log.info(`explore done in ${Date.now() - t0}ms`);
  return probe;
}

// ──────────────────────────── scrape ────────────────────────────

/** 等聊天列表加载，返回会话项数量 */
async function waitForList(page: Page, run: Run): Promise<number> {
  let n = 0;
  for (let i = 0; i < 30; i++) {
    n = await page.evaluate((sel) => document.querySelectorAll(sel).length, ITEM);
    if (n > 0) break;
    await page.waitForTimeout(1_000);
  }
  run.log.info(`会话列表加载完成：${n} 条`);
  return n;
}

/** 列表项预览信息（点开前先读，拿到去重/标识用的 name+公司+预览） */
async function readListPreview(page: Page, index: number) {
  return await page.evaluate(({ sel, index }) => {
    const items = document.querySelectorAll(sel);
    const el = items[index];
    if (!el) return null;
    const t = (s: string) => (el.querySelector(s) as HTMLElement | null)?.innerText?.trim() || undefined;
    // .title-box .name-box: <span.name-text>名</span><span>公司</span><i.vline><span>职务</span>
    const nameBox = el.querySelector('.title-box .name-box');
    const spans = nameBox ? Array.from(nameBox.querySelectorAll(':scope > span')) as HTMLElement[] : [];
    const bossName = (nameBox?.querySelector('.name-text') as HTMLElement | null)?.innerText?.trim();
    const company = spans.find((s) => !s.classList.contains('name-text'))?.innerText?.trim();
    const bossTitle = spans.length ? spans[spans.length - 1]?.innerText?.trim() : undefined;
    return {
      bossName,
      company: company && company !== bossName ? company : undefined,
      bossTitle: bossTitle && bossTitle !== company && bossTitle !== bossName ? bossTitle : undefined,
      lastMsgPreview: t('.last-msg-text'),
    };
  }, { sel: ITEM, index });
}

/** 等消息面板就绪（no-data 消失且 im-list 有内容） */
async function waitConversationReady(page: Page): Promise<boolean> {
  for (let i = 0; i < 24; i++) {
    const ready = await page.evaluate(() =>
      !document.querySelector('.chat-conversation .chat-no-data') &&
      document.querySelectorAll('.chat-message .im-list .message-item').length > 0);
    if (ready) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/** 向上滚动消息区加载历史，直到数量稳定或达上限 */
async function loadHistory(page: Page, maxScrolls: number, maxMessages: number) {
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const count = await page.evaluate(() => document.querySelectorAll('.chat-message .im-list .message-item').length);
    if (count >= maxMessages) break;
    if (count === prev) { if (++stable >= 2) break; } else stable = 0;
    prev = count;
    // 滚动 .message-content/.chat-record 到顶，触发 pre-loading
    await page.evaluate(() => {
      const c = document.querySelector('.message-content') || document.querySelector('.chat-record');
      if (c) (c as HTMLElement).scrollTop = 0;
    });
    await page.waitForTimeout(1_200);
  }
}

/** 抓顶部职位信息（点开会话后） */
async function readJobHeader(page: Page) {
  return await page.evaluate(() => {
    const t = (s: string) => (document.querySelector(s) as HTMLElement | null)?.innerText?.trim() || undefined;
    return {
      positionName: t('.chat-position-content .position-name'),
      salary: t('.chat-position-content .salary'),
      city: t('.chat-position-content .city'),
      bossName: t('.top-info-content .name-text'),
    };
  });
}

/** 抓当前会话的全部消息 */
async function readMessages(page: Page, maxMessages: number): Promise<BossMessage[]> {
  const raw = await page.evaluate(() => {
    const out: Array<{ mid?: string; cls: string; time?: string; text: string; type: string; status?: string }> = [];
    const items = Array.from(document.querySelectorAll('.chat-message .im-list > li.message-item'));
    for (const li of items) {
      const cls = li.className;
      const mid = (li as HTMLElement).getAttribute('data-mid') || undefined;
      const time = (li.querySelector('.item-time .time') as HTMLElement | null)?.innerText?.trim() || undefined;
      const status = (li.querySelector('.message-status') as HTMLElement | null)?.innerText?.trim() || undefined;

      let type = 'other';
      let text = '';
      const textContent = li.querySelector('.text-content') as HTMLElement | null;
      const card = li.querySelector('.message-card-top-title, .message-card-wrap') as HTMLElement | null;
      const link = li.querySelector('.hyper-link') as HTMLElement | null;
      if (textContent && textContent.innerText.trim()) {
        type = 'text';
        text = textContent.innerText.trim();
      } else if (card) {
        type = 'card';
        const title = (li.querySelector('.message-card-top-title') as HTMLElement | null)?.innerText?.trim() || card.innerText.trim();
        const btns = Array.from(li.querySelectorAll('.message-card-buttons .card-btn')).map((b) => (b as HTMLElement).innerText.trim()).filter(Boolean);
        text = btns.length ? `${title} [按钮:${btns.join('/')}]` : title;
      } else if (link) {
        type = 'link';
        text = link.innerText.replace(/\s+/g, ' ').trim();
      } else {
        const p = li.querySelector('.message-content') as HTMLElement | null;
        text = p?.innerText?.trim() || '';
      }
      out.push({ mid, cls, time, text, type, status });
    }
    return out;
  });

  const msgs: BossMessage[] = raw.map((r) => ({
    mid: r.mid,
    sender: (r.cls.includes('item-myself') ? 'me' : r.cls.includes('item-system') ? 'system' : 'boss') as BossMessage['sender'],
    time: r.time,
    type: r.type as BossMessage['type'],
    text: r.text,
    status: r.status,
  })).filter((m) => m.text);

  return msgs.slice(-maxMessages);
}

/** 点「查看职位」开新标签页抓 JD；按 URL 缓存去重 */
async function fetchJd(
  page: Page, run: Run,
  cache: Map<string, BossJob>,
  dumpSample: boolean,
): Promise<{ url?: string; description?: string; jdTitle?: string; jdError?: string }> {
  // 「查看职位」是 .position-content(ka=geek_chat_job_detail) 卡片，点击开新标签页。
  // 优先点更精确的 .right-content（含「查看职位」文字），退回整张卡片。
  const triggers = [
    '.chat-position-content .position-content .right-content',
    '.chat-position-content .position-content',
    '[ka="geek_chat_job_detail"]',
  ];
  let trigger = page.locator(triggers[0]).first();
  for (const sel of triggers) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0) { trigger = loc; break; }
  }
  if (await trigger.count() === 0) return { jdError: '未找到「查看职位」入口' };

  const ctx = page.context();
  // 点击常有抖动（句柄未绑定/渲染中），重试至多 3 次拿到新标签页
  let popup: Page | null = null;
  let lastErr = '';
  for (let attempt = 0; attempt < 3 && !popup; attempt++) {
    const before = new Set(ctx.pages());
    try {
      const [p] = await Promise.all([
        ctx.waitForEvent('page', { timeout: 9_000 }),
        trigger.click({ timeout: 5_000, force: attempt > 0 }),
      ]);
      // 确认是新开的页（不是之前残留的）
      popup = (before.has(p as Page) ? ctx.pages().find((pg) => !before.has(pg)) : (p as Page)) || (p as Page);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await page.waitForTimeout(800);
    }
  }
  if (!popup) return { jdError: `打开职位页失败: ${lastErr}` };

  try {
    await popup.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    // 职位页偶尔会客户端重定向；轮询正文出现，期间 URL 可能变
    await popup.locator('.job-sec-text, .job-detail-section .text, .job-sec .text').first()
      .waitFor({ state: 'attached', timeout: 8_000 }).catch(() => { /* 退回到现有 DOM 提取 */ });
    const url = popup.url();
    const cached = cache.get(url);
    if (cached) { run.log.info(`JD 命中缓存：${url}`); return { url, description: cached.description, jdTitle: cached.jdTitle }; }

    if (dumpSample) await dump(run, 'jd-sample.html', await popup.content().catch(() => '<err>'));

    // 重定向后 window.__name 会被清掉，evaluate 前必须再注入一次
    await injectNameShim(popup);
    const jd = await popup.evaluate(() => {
      const t = (sels: string[]) => {
        for (const s of sels) { const el = document.querySelector(s) as HTMLElement | null; const v = el?.innerText?.trim(); if (v) return v; }
        return undefined;
      };
      const jdTitle = t(['.job-banner .name', '.job-primary .name', '.name h1', 'h1.name', '.job-detail .name']);
      const description = t([
        '.job-sec-text', '.job-detail-section .text', '.job-sec .text',
        '.job-detail .detail-content', '[class*="job-detail"] .text', '.text',
      ]);
      return { jdTitle, description };
    });
    return { url, description: jd.description, jdTitle: jd.jdTitle };
  } catch (e) {
    return { jdError: `抓 JD 失败: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    await popup.close().catch(() => { /* ignore */ });
  }
}

async function scrapeMode(page: Page, run: Run, a: BossArgs, url: string): Promise<BossOutput> {
  const t0 = Date.now();
  const maxConvos = Math.max(0, a.maxConvos ?? 0);
  const maxMessages = Math.max(1, a.maxMessages ?? 200);
  const maxScrolls = Math.max(0, a.maxScrolls ?? 6);
  const wantJd = a.jd !== false;

  run.log.info(`boss scrape: goto ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => { /* ignore */ });
  await injectNameShim(page);

  const total = await waitForList(page, run);
  const loggedIn = total > 0 || !(await page.evaluate(() => !!document.querySelector('.login-page, .sign-form')));
  const start = Math.max(0, Math.min(a.startIndex ?? 0, total));
  const end = maxConvos > 0 ? Math.min(start + maxConvos, total) : total;

  const conversations: BossConversation[] = [];
  const jdCache = new Map<string, BossJob>();
  let dumpedJdSample = false;

  for (let i = start; i < end; i++) {
    const preview = await readListPreview(page, i);
    run.log.info(`[${i + 1}/${end}] ${preview?.bossName ?? '?'} @ ${preview?.company ?? '?'}`);
    try {
      await page.locator(ITEM).nth(i).click({ timeout: 8_000 });
    } catch (e) {
      run.log.warn(`点击会话 ${i} 失败: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const ready = await waitConversationReady(page);
    if (!ready) { run.log.warn(`会话 ${i} 消息未就绪，跳过`); }

    await loadHistory(page, maxScrolls, maxMessages);
    const header = await readJobHeader(page);
    const messages = await readMessages(page, maxMessages);

    const job: BossJob = {
      positionName: header.positionName,
      salary: header.salary,
      city: header.city,
    };
    if (wantJd) {
      const jd = await fetchJd(page, run, jdCache, !dumpedJdSample);
      dumpedJdSample = true;
      job.url = jd.url;
      job.description = jd.description;
      job.jdTitle = jd.jdTitle;
      job.jdError = jd.jdError;
      if (jd.url && jd.description) jdCache.set(jd.url, job);
      await page.waitForTimeout(600); // 节流，降低风控
    }

    conversations.push({
      index: i,
      bossName: header.bossName || preview?.bossName,
      company: preview?.company,
      bossTitle: preview?.bossTitle,
      lastMsgPreview: preview?.lastMsgPreview,
      job,
      messageCount: messages.length,
      messages,
    });
  }

  const output: BossOutput = {
    finalUrl: page.url(),
    loggedIn,
    convoTotal: total,
    scraped: conversations.length,
    conversations,
    durationMs: Date.now() - t0,
  };
  await dump(run, 'result.json', JSON.stringify({ runId: run.runId, ...output }, null, 2));
  run.log.info(`done in ${output.durationMs}ms, ${output.scraped}/${total} 条会话`);
  return output;
}

export async function runInSession(page: Page, args: unknown, run: Run): Promise<unknown> {
  const a: BossArgs = (typeof args === 'object' && args) ? (args as BossArgs) : {};
  const url = a.url || CHAT_URL;
  if (a.mode === 'explore') return exploreMode(page, run, url);
  return scrapeMode(page, run, a, url);
}
