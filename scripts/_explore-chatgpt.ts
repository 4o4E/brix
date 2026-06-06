// brix 开发探索脚本：观察 ChatGPT 对话各阶段的 DOM 状态
//
// 不固化给最终用户用。目的：跑一次画图 + 一次纯文本，每 500ms 抓 DOM 状态，
// 状态变化时打印 + 抓 HTML/截图。用来核对/定位稳定的完成信号、图片元素、下载按钮 selector
// （chatgpt-draw.ts 里的 selector 都该拿这个脚本对着真实页面验证过）。
//
// 用法：
//   npx tsx scripts/_explore-chatgpt.ts
//
// 输出：
//   data/runs/<runId>/stage-<label>-NN-*.{png,html}
//   data/runs/<runId>/explore-summary.json   时间线（每次状态变化的 diff）

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Page } from 'patchright';
import { getEnv } from '../src/config.js';
import { newTab, closeSession } from '../src/browser/session.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('explore-chatgpt');

interface State {
  streaming: boolean;
  hasSendBtn: boolean;
  hasDownloadBtn: boolean;
  assistantCount: number;
  imgCount: number;
  imgUrls: string[];
  textLength: number;
  loadingHint: string | null;
  signals: string[];
}

async function snapshotState(page: Page): Promise<State> {
  return (await page.evaluate(() => {
    const $ = (sel: string) => document.querySelector(sel);
    const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));

    const stopBtn = $('button[data-testid="stop-button"]');
    const sendBtn = $('button[data-testid="send-button"]') as HTMLButtonElement | null;
    const allButtons = $$('button');
    const downloadBtn = allButtons.find((b) => /下载|Download/i.test(b.getAttribute('aria-label') || ''));

    const assistants = $$('[data-message-author-role="assistant"]');
    const last = assistants[assistants.length - 1] || null;

    const candidateImgs = (last ? Array.from(last.querySelectorAll('img')) : []).filter((node) => {
      const img = node as HTMLImageElement;
      const url = img.currentSrc || img.src || '';
      if (!url || url.startsWith('data:')) return false;
      if (/avatar|profile|\.svg(\?|$)/i.test(url)) return false;
      const w = img.naturalWidth || 0;
      return w === 0 || w >= 64;
    });

    const textLength = last ? (last.textContent || '').length : 0;
    const bodyText = document.body.textContent || '';
    const loadingHintMatch = bodyText.match(/正在生成|正在创建|生成图[像片]中|Creating image|Generating image|making the image/i);

    const signals: string[] = [];
    const dtProbes = ['send-button', 'stop-button', 'composer-plus-btn', 'composer-speech-button'];
    for (const t of dtProbes) {
      const n = $$(`[data-testid="${t}"]`).length;
      if (n > 0) signals.push(`dt[${t}]=${n}`);
    }
    const ariaProbes = ['下载', 'Download', '复制', 'Copy', '分享', 'Share', '附加', 'Add'];
    for (const a of ariaProbes) {
      const n = $$(`button[aria-label*="${a}"]`).length;
      if (n > 0) signals.push(`btn[${a}]=${n}`);
    }

    return {
      streaming: !!stopBtn,
      hasSendBtn: !!sendBtn,
      hasDownloadBtn: !!downloadBtn,
      assistantCount: assistants.length,
      imgCount: candidateImgs.length,
      imgUrls: candidateImgs.slice(0, 6).map((i) => {
        const el = i as HTMLImageElement;
        return el.currentSrc || el.src;
      }),
      textLength,
      loadingHint: loadingHintMatch ? loadingHintMatch[0] : null,
      signals,
    };
  })) as State;
}

function diffStates(a: State, b: State): string[] {
  const changes: string[] = [];
  const scalarFields: (keyof State)[] = ['streaming', 'hasSendBtn', 'hasDownloadBtn',
    'assistantCount', 'imgCount', 'loadingHint'];
  for (const f of scalarFields) {
    if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
      changes.push(`${f}: ${JSON.stringify(a[f])} → ${JSON.stringify(b[f])}`);
    }
  }
  const bucket = (n: number) => n === 0 ? 0 : n < 50 ? 1 : n < 200 ? 2 : n < 1000 ? 3 : 4;
  if (bucket(a.textLength) !== bucket(b.textLength)) {
    changes.push(`textLength: ${a.textLength} → ${b.textLength}`);
  }
  if (a.signals.join('|') !== b.signals.join('|')) {
    changes.push(`signals: [${a.signals.join(',')}] → [${b.signals.join(',')}]`);
  }
  if (a.imgUrls.length !== b.imgUrls.length || a.imgUrls.some((u, i) => u !== b.imgUrls[i])) {
    changes.push(`imgUrls: ${a.imgUrls.length} → ${b.imgUrls.length}`);
  }
  return changes;
}

async function dumpStage(page: Page, runDir: string, tag: string) {
  const png = join(runDir, `stage-${tag}.png`);
  const html = join(runDir, `stage-${tag}.html`);
  await page.screenshot({ path: png, fullPage: true }).catch(() => { /* ignore */ });
  await writeFile(html, await page.content().catch(() => '<error>')).catch(() => { /* ignore */ });
}

async function runOne(page: Page, prompt: string, runDir: string, label: string) {
  log.info(`=== ${label}: prompt="${prompt}" ===`);

  const input = await page.waitForSelector(
    'div#prompt-textarea[contenteditable="true"], #prompt-textarea[contenteditable="true"]',
    { state: 'visible', timeout: 30_000 },
  );
  await input.click();
  await page.keyboard.press('Control+A').catch(() => { /* ignore */ });
  await page.keyboard.press('Delete').catch(() => { /* ignore */ });
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(300);
  await dumpStage(page, runDir, `${label}-00-typed`);

  const t0 = Date.now();
  const timeline: Array<State & { ts: number; changes: string[] }> = [];

  const initial = await snapshotState(page);
  timeline.push({ ...initial, ts: 0, changes: ['initial'] });
  await dumpStage(page, runDir, `${label}-01-pre-send`);
  let lastState = initial;

  const sendBtn = page.locator('button[data-testid="send-button"]').first();
  try {
    await sendBtn.click({ timeout: 5_000 });
  } catch {
    await page.keyboard.press('Enter');
  }
  log.info(`${label}: send triggered`);

  const maxMs = 300_000;
  const idleMaxMs = 18_000;
  let lastChangeMs = Date.now();
  let stageCounter = 2;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(500);
    let cur: State;
    try {
      cur = await snapshotState(page);
    } catch (e) {
      log.warn(`snapshot failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const changes = diffStates(lastState, cur);
    if (changes.length > 0) {
      const ts = Date.now() - t0;
      log.info(`${label} +${ts}ms ${changes.join('; ')}`);
      timeline.push({ ...cur, ts, changes });
      await dumpStage(page, runDir, `${label}-${String(stageCounter++).padStart(2, '0')}-change`);
      lastChangeMs = Date.now();
      lastState = cur;
    }
    if (!cur.streaming && cur.assistantCount > initial.assistantCount && Date.now() - lastChangeMs > idleMaxMs) {
      log.info(`${label}: response done (no stop btn + ${idleMaxMs}ms idle)`);
      break;
    }
  }

  await dumpStage(page, runDir, `${label}-99-final`);
  return timeline;
}

async function main() {
  const env = getEnv();
  const runId = `explore_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const runDir = join(env.DATA_DIR, 'runs', runId);
  await mkdir(runDir, { recursive: true });

  log.info(`runId=${runId} runDir=${runDir}`);

  const page = await newTab('https://chatgpt.com/');
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => { /* ignore */ });
  await page.waitForTimeout(2_000);
  await dumpStage(page, runDir, 'page-loaded');

  try {
    const drawTL = await runOne(page, '画一只在月亮上喝茶的橘猫，水彩风格', runDir, 'draw');
    await page.waitForTimeout(3_000);
    const textTL = await runOne(page, '用一句话告诉我什么是空气', runDir, 'text');

    const summary = {
      runId,
      runs: {
        draw: { count: drawTL.length, timeline: drawTL },
        text: { count: textTL.length, timeline: textTL },
      },
    };
    const summaryPath = join(runDir, 'explore-summary.json');
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
    log.info(`summary: ${summaryPath}`);

    console.log(`\n=== summary ===`);
    console.log(`runId: ${runId}`);
    console.log(`runDir: ${runDir}`);
    console.log(`draw transitions: ${drawTL.length}, final imgCount=${drawTL[drawTL.length - 1].imgCount}, signals=[${drawTL[drawTL.length - 1].signals.join(',')}]`);
    console.log(`text transitions: ${textTL.length}, final textLength=${textTL[textTL.length - 1].textLength}, signals=[${textTL[textTL.length - 1].signals.join(',')}]`);
  } finally {
    await page.close().catch(() => { /* ignore */ });
    await closeSession();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
