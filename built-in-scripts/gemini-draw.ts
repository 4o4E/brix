// brix 内置脚本：用 Gemini 网页生成图片
//
// 执行入口：POST /sessions/:sid/scripts/gemini-draw
//   body: { args: { prompt: "..." } }
//   body: { args: { prompt: "...", images: [{ filename, mimeType, dataUrl }] } }
//
// 这是 server-side DOM 脚本：除了 type 之外不导入任何 brix 模块。
// 所有 runtime 依赖（logger / takeSnapshot / saveDownload 等）都从第 3 个参数 `run` 取，
// 这样脚本被 bootstrap 从 built-in-scripts/ 拷到 data/scripts/ 之后仍然能跑
// （data/scripts/ 不在 repo 根下，相对 import 解析不到 src/）。
//
// 完成判定：
//   - 发送按钮 aria-label 重新变回 "发送"
//   - 新增至少 1 个 model-response（相对发送前的 baseline）
//   - 连续 8s 无 DOM 状态变化
//
// 结果分流：
//   - <single-image> 数量 > 0 → 画图成功，只点一次 "下载完整尺寸的图片",
//                                  Playwright 监听 download 事件 → run.saveDownload
//   - 否则若 model-response textLength > 0 → 文字回复
//   - 否则 → empty
//
// 产物：
//   <run.downloadsDir>/image-N.<ext>     生成的图片（HTTP 暴露）
//   <run.dir>/page.png                   结果页整页截图
//   <run.dir>/page.html                  结果页 HTML
//   <run.dir>/result.json                结构化结果
//   <run.dir>/stage-*.{png,html}         阶段诊断快照

import { extname } from 'node:path';
import type { Page } from 'patchright';
import type { Run } from '../src/runs/run.js';

export const meta = {
  description: '用 Gemini 网页生成图片或文字回复，图片落到 run 的 downloads/',
  argsExample: {
    prompt: '把图1做成一张 VTuber 出道海报',
    images: [
      {
        filename: 'image-1.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,...',
      },
    ],
  },
};

interface GeminiArgs {
  prompt: string;
  images: UploadImageInput[];
}

interface UploadImageInput {
  filename?: string;
  mimeType?: string;
  base64?: string;
  dataUrl?: string;
}

interface ImageItem {
  index: number;
  alt?: string;
  blobUrl?: string;
  savedAs: string;
  bytes?: number;
  suggestedFilename?: string;
}

export interface GeminiOutput {
  prompt: string;
  mode: 'image' | 'text' | 'empty';
  images: ImageItem[];
  text: string;
  finalUrl: string;
  durationMs: number;
}

interface PageState {
  sendBtnLabel: string | null;
  modelResponseCount: number;
  singleImageCount: number;
  downloadBtnCount: number;
  textLength: number;
  loadingHint: string | null;
}

function coerceArgs(args: unknown): GeminiArgs {
  if (typeof args === 'string') return { prompt: args, images: [] };
  if (Array.isArray(args) && typeof args[0] === 'string') return { prompt: args[0], images: [] };
  if (args && typeof args === 'object' && typeof (args as { prompt?: unknown }).prompt === 'string') {
    const obj = args as { prompt: string; images?: unknown };
    const images = Array.isArray(obj.images) ? obj.images.map(coerceUploadImage) : [];
    return { prompt: obj.prompt, images };
  }
  throw new Error('gemini-draw: args.prompt (string) is required');
}

function coerceUploadImage(input: unknown): UploadImageInput {
  if (!input || typeof input !== 'object') {
    throw new Error('gemini-draw: args.images[] must be object');
  }
  const obj = input as Record<string, unknown>;
  const image: UploadImageInput = {};
  if (typeof obj.filename === 'string') image.filename = obj.filename;
  if (typeof obj.mimeType === 'string') image.mimeType = obj.mimeType;
  if (typeof obj.base64 === 'string') image.base64 = obj.base64;
  if (typeof obj.dataUrl === 'string') image.dataUrl = obj.dataUrl;
  if (!image.base64 && !image.dataUrl) {
    throw new Error('gemini-draw: args.images[] requires base64 or dataUrl');
  }
  return image;
}

function decodeUploadImage(input: UploadImageInput): Buffer {
  if (input.dataUrl) {
    const m = /^data:([^;,]+);base64,(.*)$/.exec(input.dataUrl);
    if (!m) throw new Error('gemini-draw: image.dataUrl must be base64 data URL');
    return Buffer.from(m[2], 'base64');
  }
  return Buffer.from(input.base64 ?? '', 'base64');
}

function uploadExt(input: UploadImageInput): string {
  const nameExt = input.filename ? extname(input.filename).toLowerCase() : '';
  if (/^\.[A-Za-z0-9]{1,8}$/.test(nameExt)) return nameExt;
  if (input.mimeType === 'image/jpeg') return '.jpg';
  if (input.mimeType === 'image/webp') return '.webp';
  if (input.mimeType === 'image/avif') return '.avif';
  if (input.mimeType === 'image/heif') return '.heif';
  if (input.mimeType === 'image/heic') return '.heic';
  return '.png';
}

async function snap(page: Page, run: Run, tag: string) {
  try {
    const png = await page.screenshot({ fullPage: true });
    await run.writeArtifact(`stage-${tag}.png`, png);
  } catch { /* ignore */ }
  try {
    const html = await page.content();
    await run.writeArtifact(`stage-${tag}.html`, html);
  } catch { /* ignore */ }
  run.log.info(`stage=${tag}`);
}

async function getState(page: Page): Promise<PageState> {
  return (await page.evaluate(() => {
    const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));
    const sendBtn = document.querySelector('button[aria-label="发送"], button[aria-label="停止响应"]') as HTMLButtonElement | null;
    const downloadBtns = $$('button').filter((b) => /下载|Download/i.test(b.getAttribute('aria-label') || ''));
    const textNodes = $$('model-response .markdown, model-response message-content, model-response .model-response-text');
    const textLength = textNodes.reduce((s, n) => s + (n.textContent?.length || 0), 0);
    const bodyText = document.body.textContent || '';
    const loadingMatch = bodyText.match(/正在创建您的图片|正在创建|正在生成|Generating image|Creating your image/);
    return {
      sendBtnLabel: sendBtn ? sendBtn.getAttribute('aria-label') : null,
      modelResponseCount: $$('model-response').length,
      singleImageCount: $$('single-image').length,
      downloadBtnCount: downloadBtns.length,
      textLength,
      loadingHint: loadingMatch ? loadingMatch[0] : null,
    };
  })) as PageState;
}

function stateChanged(a: PageState, b: PageState): boolean {
  return (
    a.sendBtnLabel !== b.sendBtnLabel ||
    a.modelResponseCount !== b.modelResponseCount ||
    a.singleImageCount !== b.singleImageCount ||
    a.downloadBtnCount !== b.downloadBtnCount ||
    a.loadingHint !== b.loadingHint ||
    Math.abs(a.textLength - b.textLength) > 5
  );
}

async function waitForResponseComplete(page: Page, run: Run, baselineModelCount: number): Promise<PageState> {
  const idleMs = 8_000;
  const maxMs = 240_000;
  const start = Date.now();
  let last = await getState(page);
  let lastChangeMs = Date.now();

  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(500);
    let cur: PageState;
    try {
      cur = await getState(page);
    } catch (e) {
      run.log.warn(`getState err: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (stateChanged(last, cur)) {
      run.log.debug(`state change at +${Date.now() - start}ms: sendBtn=${cur.sendBtnLabel} model=${cur.modelResponseCount} img=${cur.singleImageCount} dl=${cur.downloadBtnCount} text=${cur.textLength} loading=${cur.loadingHint}`);
      lastChangeMs = Date.now();
      last = cur;
    }
    if (
      cur.modelResponseCount > baselineModelCount &&
      cur.sendBtnLabel === '发送' &&
      Date.now() - lastChangeMs >= idleMs
    ) {
      return cur;
    }
  }
  run.log.warn(`response not stable within ${maxMs}ms, returning last observed state`);
  return last;
}

async function downloadImages(page: Page, run: Run): Promise<ImageItem[]> {
  const wrappers = page.locator('single-image');
  const count = await wrappers.count();
  run.log.info(`single-image count=${count}, downloading first available image...`);

  for (let i = 0; i < count; i++) {
    const wrap = wrappers.nth(i);
    const dlBtn = wrap.locator('button[aria-label*="下载"], button[aria-label*="Download"]').first();
    if ((await dlBtn.count()) === 0) {
      run.log.warn(`single-image #${i} has no download button, skip`);
      continue;
    }

    const blobUrl = await wrap.locator('img').first().getAttribute('src').catch(() => null);
    const alt = await wrap.locator('img').first().getAttribute('alt').catch(() => null);
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        dlBtn.click({ timeout: 10_000 }),
      ]);
      const suggested = download.suggestedFilename();
      const ext = extname(suggested).toLowerCase() || '.png';
      const saved = await run.saveDownload(download, `image-${i}${ext}`);
      run.log.info(`downloaded #${i} ${saved.bytes} bytes -> ${saved.name}`);
      return [{
        index: i,
        alt: alt || undefined,
        blobUrl: blobUrl || undefined,
        savedAs: saved.name,
        bytes: saved.bytes,
        suggestedFilename: suggested,
      }];
    } catch (e) {
      run.log.warn(`download #${i} failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }
  return [];
}

async function openUploadMenu(page: Page, run: Run): Promise<boolean> {
  const plus = page.locator('button[aria-label="上传和工具"]').first();
  try {
    await plus.waitFor({ state: 'visible', timeout: 10_000 });
    await plus.click();
    await page.waitForTimeout(500);
    return true;
  } catch (e) {
    run.log.warn(`"+" (上传和工具) not found: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

async function uploadImages(page: Page, run: Run, images: UploadImageInput[]): Promise<string[]> {
  if (images.length === 0) return [];
  const uploadedPaths: string[] = [];
  run.log.info(`uploading ${images.length} input image(s)`);

  for (let i = 0; i < images.length; i++) {
    if (!(await openUploadMenu(page, run))) {
      throw new Error('gemini-draw: upload menu not found');
    }

    const uploadPath = await run.writeArtifact(`upload-${i}${uploadExt(images[i])}`, decodeUploadImage(images[i]));
    const uploadMenuItem = page.locator('button[role="menuitem"]').filter({ hasText: '上传文件' }).first();
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15_000 }),
        uploadMenuItem.click({ timeout: 10_000 }),
      ]);
      await chooser.setFiles(uploadPath);
      uploadedPaths.push(uploadPath);
      run.log.info(`uploaded input image #${i} -> ${uploadPath}`);
    } catch (e) {
      throw new Error(`gemini-draw: upload image #${i} failed: ${e instanceof Error ? e.message : e}`);
    }

    // Gemini 上传附件后会异步生成缩略条，过早切模式或输入会丢附件。
    await page.waitForTimeout(5_000);
  }

  await snap(page, run, '01a-uploaded');
  return uploadedPaths;
}

/**
 * 切到 "制作图片" 模式：点输入框旁的 "+"（aria-label="上传和工具"），
 * 在弹出菜单里点 "制作图片"。
 *
 * 不强制：找不到 "+" 或菜单项就 warn 后跳过，Gemini 仍可能按 prompt 文意
 * 自行生成图。失败兜底按 Esc 把可能打开的菜单关掉。
 */
async function selectImageMode(page: Page, run: Run): Promise<void> {
  run.log.info('selecting image mode: click "+" → "制作图片"');
  if (!(await openUploadMenu(page, run))) {
    return;
  }
  // Material 菜单可能是 [role="menuitem"] 或 button 或 [mat-menu-item]；
  // 都用 has-text("制作图片") 兜底，谁先 visible 算谁。
  const item = page.locator(
    '[role="menuitem"]:has-text("制作图片"), button:has-text("制作图片"), [mat-menu-item]:has-text("制作图片")',
  ).first();
  try {
    await item.waitFor({ state: 'visible', timeout: 5_000 });
    await item.click();
    run.log.info('"制作图片" clicked');
  } catch (e) {
    run.log.warn(`"制作图片" menu item not found: ${e instanceof Error ? e.message : e}`);
    await page.keyboard.press('Escape').catch(() => { /* ignore */ });
  }
  await page.waitForTimeout(500);
  await snap(page, run, '01b-image-mode');
}

async function extractLastResponseText(page: Page): Promise<string> {
  return (await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('model-response'));
    const last = all[all.length - 1];
    if (!last) return '';
    return (last.textContent || '').trim();
  })) as string;
}

export async function runInSession(page: Page, args: unknown, run: Run): Promise<GeminiOutput> {
  const { prompt, images: inputImages } = coerceArgs(args);
  const t0 = Date.now();
  run.log.info(`prompt="${prompt}" inputImages=${inputImages.length}`);

  if (!/^https?:\/\/gemini\.google\.com\//.test(page.url())) {
    run.log.info('not on gemini, goto gemini.google.com/app');
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => { /* ignore */ });
    await page.waitForTimeout(1_500);
  }
  await snap(page, run, '01-loaded');

  // 输入框选择器在切模式后会重新渲染 —— 用 Locator 而不是 ElementHandle，
  // 每次 action 自动重新解析当前 DOM
  const inputSel = 'div.ql-editor[contenteditable="true"][role="textbox"]';
  await page.waitForSelector(inputSel, { state: 'visible', timeout: 30_000 });

  if (inputImages.length > 0) {
    const input = page.locator(inputSel).first();
    await input.click();
    await page.keyboard.press('Control+A').catch(() => { /* ignore */ });
    await page.keyboard.press('Delete').catch(() => { /* ignore */ });
  }
  await uploadImages(page, run, inputImages);

  // 显式切到图片模式 —— 不依赖 Gemini 自动从 prompt 文意推断
  await selectImageMode(page, run);

  await page.evaluate('window.__name = window.__name || function(fn){return fn;};');
  const baseline = await getState(page);
  run.log.info(`baseline modelResponseCount=${baseline.modelResponseCount}`);

  // 切模式后等 input 重渲染稳定（取消按 Esc 兜底也可能引发 reflow）
  await page.waitForSelector(inputSel, { state: 'visible', timeout: 5_000 });
  const input = page.locator(inputSel).first();
  await input.click();
  if (inputImages.length === 0) {
    await page.keyboard.press('Control+A').catch(() => { /* ignore */ });
    await page.keyboard.press('Delete').catch(() => { /* ignore */ });
  }
  await page.keyboard.type(prompt, { delay: 8 });
  await page.waitForTimeout(300);

  const sendBtn = await page.waitForSelector('button[aria-label="发送"]', { state: 'visible', timeout: 5_000 });
  await sendBtn.click();
  run.log.info('send clicked, waiting for response');
  await snap(page, run, '02-sent');

  const final = await waitForResponseComplete(page, run, baseline.modelResponseCount);
  run.log.info(`response done: singleImage=${final.singleImageCount} text=${final.textLength} download=${final.downloadBtnCount}`);
  await snap(page, run, '03-response-done');

  const images = final.singleImageCount > 0 ? await downloadImages(page, run) : [];
  const text = images.length === 0 ? await extractLastResponseText(page) : '';
  const mode: GeminiOutput['mode'] = images.length > 0 ? 'image' : text ? 'text' : 'empty';

  const screenshot = await page.screenshot({ fullPage: true });
  await run.writeArtifact('page.png', screenshot);
  await run.writeArtifact('page.html', await page.content());

  const output: GeminiOutput = {
    prompt,
    mode,
    images,
    text,
    finalUrl: page.url(),
    durationMs: Date.now() - t0,
  };
  await run.writeArtifact('result.json', JSON.stringify({ runId: run.runId, ...output }, null, 2));
  run.log.info(`done in ${output.durationMs}ms mode=${mode} images=${images.length}`);
  return output;
}
