// brix 内置脚本：Google Lens 识图 + 抓取候选页
//
// 执行入口：POST /sessions/:sid/scripts/google-lens
//   body: { args: { image: "data:image/png;base64,..." } }  或  { args: { imagePath: "C:/path/to.png" } }
//
// server-side DOM 脚本：只能 import type，其它 runtime 依赖走 `run` 参数。
//
// 产物：
//   <run.dir>/page.png                结果页整页截图
//   <run.dir>/page.html               结果页 HTML
//   <run.dir>/result.json             结构化候选
//   <run.dir>/stage-*.{png,html}      阶段诊断快照
//   <run.dir>/upload.png              上传用的临时图片（保留以便复现）

import { readFile, stat } from 'node:fs/promises';
import type { Page } from 'patchright';
import type { Run } from '../src/runs/run.js';

export const meta = {
  description: 'Google Lens 识图，抓取候选页面（去重后返回）',
  argsExample: { image: 'data:image/png;base64,iVBORw0KG...' },
};

interface LensArgs {
  /** base64 字符串、data URL 或绝对文件路径任选其一 */
  image?: string;
  imagePath?: string;
}

interface LensItem {
  title: string;
  url: string;
  sourceDomain: string;
  thumbnailUrl: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
}

export interface LensOutput {
  pages: LensItem[];
  visualMatches: LensItem[];
  finalUrl: string;
  durationMs: number;
}

function isLikelyImageBytes(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true; // BMP
  if (buf[0] === 0x49 && buf[1] === 0x49) return true; // TIFF LE
  if (buf[0] === 0x4d && buf[1] === 0x4d) return true; // TIFF BE
  if (buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return true;
  return false;
}

async function loadImageBytes(input: string): Promise<Buffer> {
  const stripDataUrl = (s: string) => s.replace(/^data:image\/[\w+]+;base64,/, '').trim();
  try {
    const s = await stat(input);
    if (s.isFile()) {
      const raw = await readFile(input);
      if (isLikelyImageBytes(raw)) return raw;
      const text = raw.toString('utf-8').trim();
      return Buffer.from(stripDataUrl(text), 'base64');
    }
  } catch { /* not a file path */ }
  return Buffer.from(stripDataUrl(input), 'base64');
}

async function coerceArgs(args: unknown): Promise<Buffer> {
  let a: LensArgs;
  if (typeof args === 'string') a = { image: args };
  else if (Array.isArray(args) && typeof args[0] === 'string') a = { image: args[0] };
  else if (args && typeof args === 'object') a = args as LensArgs;
  else throw new Error('google-lens: args.image (base64/dataURL) or args.imagePath required');

  if (a.imagePath) {
    const buf = await readFile(a.imagePath);
    if (buf.length === 0) throw new Error('google-lens: imagePath file is empty');
    return buf;
  }
  if (typeof a.image === 'string' && a.image.length > 0) {
    const buf = await loadImageBytes(a.image);
    if (buf.length === 0) throw new Error('google-lens: decoded image is empty');
    return buf;
  }
  throw new Error('google-lens: args.image or args.imagePath required');
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
  run.log.info(`stage=${tag} url=${page.url()}`);
}

async function uploadAndExtract(page: Page, imagePath: string, run: Run) {
  run.log.info('goto lens.google.com');
  await page.goto('https://lens.google.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => { /* ignore */ });
  await snap(page, run, '01-loaded');

  const fileInputs = await page.$$eval('input[type="file"]', (els) =>
    (els as HTMLInputElement[]).map((e) => ({
      name: e.getAttribute('name'),
      accept: e.getAttribute('accept'),
      visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
    })),
  );
  run.log.debug(`file inputs found: ${JSON.stringify(fileInputs)}`);

  const fileInput = await page.waitForSelector('input[name="encoded_image"]', { state: 'attached', timeout: 15_000 });
  await fileInput.setInputFiles(imagePath);
  run.log.info('setInputFiles done, waiting for navigation');
  await page.waitForTimeout(3_000);
  await snap(page, run, '02-after-upload');

  try {
    await page.waitForURL(/\/search\?/, { timeout: 60_000 });
  } catch (e) {
    if (page.url().includes('/sorry/')) {
      await snap(page, run, '03-captcha');
      run.log.warn('遇到 Google reCAPTCHA，请在浏览器手动完成验证（等待 5 分钟）');
      await page.waitForURL(/\/search\?/, { timeout: 300_000 });
    } else {
      await snap(page, run, '03-timeout');
      throw e;
    }
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => { /* ignore */ });
  await page.waitForTimeout(2_000);
  await snap(page, run, '04-results');

  await page.evaluate('window.__name = window.__name || function(fn){return fn;};');

  return await page.evaluate(() => {
    const safeUrl = (s: string | null | undefined) => {
      if (!s) return '';
      try { return new URL(s, location.href).href; } catch { return s; }
    };
    const safeDomain = (s: string) => {
      try { return new URL(s).hostname; } catch { return ''; }
    };

    type Item = {
      title: string;
      url: string;
      sourceDomain: string;
      thumbnailUrl: string;
      thumbnailWidth?: number;
      thumbnailHeight?: number;
    };

    const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const items: Item[] = [];
    for (const a of anchors) {
      const img = a.querySelector('img') as HTMLImageElement | null;
      if (!img) continue;
      const href = a.href;
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
      const domain = safeDomain(href);
      if (!domain) continue;
      if (/(^|\.)google\.com$/.test(domain)) continue;
      if (/(^|\.)gstatic\.com$/.test(domain)) continue;
      if (/(^|\.)googleusercontent\.com$/.test(domain)) continue;

      const title = (a.getAttribute('aria-label') || a.textContent || img.alt || '').trim();
      items.push({
        title,
        url: safeUrl(href),
        sourceDomain: domain,
        thumbnailUrl: img.src,
        thumbnailWidth: img.naturalWidth || undefined,
        thumbnailHeight: img.naturalHeight || undefined,
      });
    }

    const seen = new Set<string>();
    const dedup: Item[] = [];
    for (const it of items) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      dedup.push(it);
    }
    return { pages: dedup, visualMatches: dedup };
  });
}

export async function runInSession(page: Page, args: unknown, run: Run): Promise<LensOutput> {
  const bytes = await coerceArgs(args);
  run.log.info(`bytes=${bytes.length}`);

  const uploadPath = await run.writeArtifact('upload.png', bytes);
  const t0 = Date.now();

  const { pages, visualMatches } = await uploadAndExtract(page, uploadPath, run);

  const screenshot = await page.screenshot({ fullPage: true });
  await run.writeArtifact('page.png', screenshot);
  await run.writeArtifact('page.html', await page.content());

  const output: LensOutput = {
    pages,
    visualMatches,
    finalUrl: page.url(),
    durationMs: Date.now() - t0,
  };
  await run.writeArtifact('result.json', JSON.stringify({ runId: run.runId, ...output }, null, 2));
  run.log.info(`done in ${output.durationMs}ms, ${pages.length} item(s)`);
  return output;
}
