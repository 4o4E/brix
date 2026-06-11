// brix 内置脚本：用 ChatGPT 网页生成图片
//
// 执行入口：POST /sessions/:sid/scripts/chatgpt-draw
//   body: { args: { prompt: "..." } }
//   body: { args: { prompt: "...", images: [{ filename, mimeType, dataUrl }] } }
//
// 这是 server-side DOM 脚本：除了 type 之外不导入任何 brix 模块。
// 所有 runtime 依赖（logger / takeSnapshot / saveDownload 等）都从第 3 个参数 `run` 取，
// 这样脚本被 bootstrap 从 built-in-scripts/ 拷到 data/scripts/ 之后仍然能跑
// （data/scripts/ 不在 repo 根下，相对 import 解析不到 src/）。
//
// 与 gemini-draw 的对照（同一套思路换 DOM）：
//   输入框        gemini: div.ql-editor      chatgpt: div#prompt-textarea (ProseMirror)
//   发送/停止     gemini: aria-label 发送/停止响应  chatgpt: data-testid send-button/stop-button
//   回复容器      gemini: <model-response>   chatgpt: [data-testid^="conversation-turn"]（末轮=助手轮）
//   图片元素      gemini: <single-image>     chatgpt: 末轮里 src=backend-api/estuary/content 的 <img>
//
// 完成判定（画图分文字流 + 异步出图两段，不能只看 stop-button）：
//   - stop-button 只跟文字流；真正画图阶段无 stop-button，只有"正在创建图片/正在打草稿…"文案
//   - 完成 = 对话轮数 > baseline 且 无 stop-button 且 无"正在…"文案 且 连续 8s 无变化
//   - 且：一旦见过画图文案，必须真出图（images>0）才收尾；纯文字回复走文字分支不被连坐
//
// 结果分流：
//   - 末条 assistant 里有生成图 → 画图成功，逐张抓取图片字节落到 downloads/
//   - 否则若末条 assistant textLength > 0 → 文字回复
//   - 否则 → empty
//
// 图片抓取策略（两层兜底）：
//   1. 页面内 fetch 图片 src → Blob → 合成 <a download> 点击，
//      Playwright 监听 download 事件 → run.saveDownload（浏览器网络栈能取同源签名 URL）
//   2. fetch 失败 → 退回点 ChatGPT 自带的图片下载按钮
//   （不用 context().request.get：本机 Node 侧直连 CDN 会撞不可达 IPv6，白卡 ~21s）
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
  description: '用 ChatGPT 网页生成图片或文字回复，图片落到 run 的 downloads/',
  argsExample: {
    prompt: '画一只在月亮上喝茶的橘猫，水彩风格',
    images: [
      {
        filename: 'image-1.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,...',
      },
    ],
  },
};

interface ChatGptArgs {
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
  srcUrl?: string;
  savedAs: string;
  bytes?: number;
  suggestedFilename?: string;
}

export interface ChatGptOutput {
  prompt: string;
  mode: 'image' | 'text' | 'empty';
  images: ImageItem[];
  text: string;
  finalUrl: string;
  durationMs: number;
  /** 各阶段耗时（ms）：nav/upload/selectImageMode/send/wait/download/finalize */
  timings?: Record<string, number>;
}

interface GenImage {
  src: string;
  alt?: string;
}

interface PageState {
  streaming: boolean;
  assistantCount: number;
  /** 末轮里识别出的生成图（已去重）。imageCount = images.length。 */
  images: GenImage[];
  textLength: number;
  loadingHint: string | null;
}

function coerceArgs(args: unknown): ChatGptArgs {
  if (typeof args === 'string') return { prompt: args, images: [] };
  if (Array.isArray(args) && typeof args[0] === 'string') return { prompt: args[0], images: [] };
  if (args && typeof args === 'object' && typeof (args as { prompt?: unknown }).prompt === 'string') {
    const obj = args as { prompt: string; images?: unknown };
    const images = Array.isArray(obj.images) ? obj.images.map(coerceUploadImage) : [];
    return { prompt: obj.prompt, images };
  }
  throw new Error('chatgpt-draw: args.prompt (string) is required');
}

function coerceUploadImage(input: unknown): UploadImageInput {
  if (!input || typeof input !== 'object') {
    throw new Error('chatgpt-draw: args.images[] must be object');
  }
  const obj = input as Record<string, unknown>;
  const image: UploadImageInput = {};
  if (typeof obj.filename === 'string') image.filename = obj.filename;
  if (typeof obj.mimeType === 'string') image.mimeType = obj.mimeType;
  if (typeof obj.base64 === 'string') image.base64 = obj.base64;
  if (typeof obj.dataUrl === 'string') image.dataUrl = obj.dataUrl;
  if (!image.base64 && !image.dataUrl) {
    throw new Error('chatgpt-draw: args.images[] requires base64 or dataUrl');
  }
  return image;
}

function decodeUploadImage(input: UploadImageInput): Buffer {
  if (input.dataUrl) {
    const m = /^data:([^;,]+);base64,(.*)$/.exec(input.dataUrl);
    if (!m) throw new Error('chatgpt-draw: image.dataUrl must be base64 data URL');
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

function mimeToExt(mime: string | undefined): string {
  if (!mime) return '.png';
  if (/jpe?g/i.test(mime)) return '.jpg';
  if (/webp/i.test(mime)) return '.webp';
  if (/gif/i.test(mime)) return '.gif';
  if (/avif/i.test(mime)) return '.avif';
  return '.png';
}

// 阶段诊断快照 —— 只在 debug run 落盘（stage-*.png/html 体积大，平时堆满磁盘）。
async function snap(page: Page, run: Run, tag: string) {
  if (!run.debug) return;
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
    const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label*="停止"], button[aria-label*="Stop"]');
    // ChatGPT 的对话轮用 data-testid="conversation-turn-N"（不是 data-message-author-role）。
    // 末轮 = 最新一轮；发送后用户轮+助手轮都会追加，助手轮在最后。
    const turns = $$('[data-testid^="conversation-turn"]');
    const last = turns[turns.length - 1] || null;

    // 生成图：末轮里非 aria-hidden、src 指向后端图片内容（estuary/content）或 alt 带"已生成图片"。
    // ChatGPT 会叠 2~3 个 <img>（渐进加载层，其余 aria-hidden），按 src 去重避免多计。
    // 这是生成图识别的唯一出处：waitForResponseComplete 用 images.length，下载也复用同一份。
    const images: Array<{ src: string; alt?: string }> = [];
    if (last) {
      const seen = new Set<string>();
      for (const node of Array.from(last.querySelectorAll('img'))) {
        const img = node as HTMLImageElement;
        if (img.getAttribute('aria-hidden') === 'true') continue;
        const url = img.currentSrc || img.src || '';
        if (!url || url.startsWith('data:')) continue;
        const isGen = /backend-api\/.*content|\/estuary\//i.test(url) || /已生成图片|Generated image/i.test(img.getAttribute('alt') || '');
        if (!isGen || seen.has(url)) continue;
        seen.add(url);
        images.push({ src: url, alt: img.getAttribute('alt') || undefined });
      }
    }

    // loadingHint 只看末轮文字（别扫整页，侧栏标题可能也含"正在"造成误判）。
    // 画图分多个阶段：正在创建图片 / 正在打草稿 / 正在生成 / 正在润色…，用 "正在+N个汉字"
    // 通配兜住所有阶段，免得逐句穷举漏掉某个新文案。
    const turnText = last ? (last.textContent || '') : '';
    const textLength = turnText.length;
    const loadingMatch = turnText.match(/正在[一-龥]{1,8}|生成图[像片]中|Creating image|Generating image|making the image|Drawing|Rendering/i);

    return {
      streaming: !!stopBtn,
      assistantCount: turns.length,
      images,
      textLength,
      loadingHint: loadingMatch ? loadingMatch[0] : null,
    };
  })) as PageState;
}

function stateChanged(a: PageState, b: PageState): boolean {
  return (
    a.streaming !== b.streaming ||
    a.assistantCount !== b.assistantCount ||
    a.images.length !== b.images.length ||
    a.loadingHint !== b.loadingHint ||
    Math.abs(a.textLength - b.textLength) > 5
  );
}

async function waitForResponseComplete(page: Page, run: Run, baselineAssistantCount: number): Promise<PageState> {
  const idleMs = 8_000;
  // 画图比纯文本慢得多（gpt-image 经常 60-120s），给够上限。
  const maxMs = 300_000;
  const start = Date.now();
  let last = await getState(page);
  let lastChangeMs = Date.now();
  let sawGenerating = false;
  let firstImageMs = -1; // 首次观测到生成图的相对时刻，用于看"出图后还空等了多久"

  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(500);
    let cur: PageState;
    try {
      cur = await getState(page);
    } catch (e) {
      run.log.warn(`getState err: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (firstImageMs < 0 && cur.images.length > 0) {
      firstImageMs = Date.now() - start;
      run.log.info(`first image observed at +${firstImageMs}ms`);
    }
    // sawGenerating 只认"画图阶段"标记（loadingHint），不能带上 cur.streaming：
    // 文字回复也会显示 stop-button（streaming=true），若用它置位会把纯文字回复也
    // 误判成"在画图"，于是 imageCount 永远 0、完成分支进不去，干等到 maxMs(300s)。
    if (cur.loadingHint) sawGenerating = true;
    if (stateChanged(last, cur)) {
      run.log.debug(`state change at +${Date.now() - start}ms: streaming=${cur.streaming} assistant=${cur.assistantCount} img=${cur.images.length} text=${cur.textLength} loading=${cur.loadingHint}`);
      lastChangeMs = Date.now();
      last = cur;
    }
    // 注意：stop-button 只跟文字流；ChatGPT 先秒回 "正在创建图片" 文字（stop 随即消失），
    // 真正的画图是后续异步阶段（无 stop-button）。所以完成判定必须排掉 loadingHint。
    // 再加一道：一旦见过"生成中"，必须真出图（images>0）才收尾，挡住相邻阶段之间
    // 那段没文案/没图的空窗导致的提前结束；纯文字回复（从没进生成态）走文字分支。
    // 图已出现时用更短的静默阈值（3s）即可收尾——图 src 是最终内容、不会再变；
    // 还没出图/纯文字时保持 8s，给跨阶段空窗留余量。省掉出图后约 5s 干等。
    const idleNeeded = cur.images.length > 0 ? 3_000 : idleMs;
    const quiet =
      cur.assistantCount > baselineAssistantCount &&
      !cur.streaming &&
      !cur.loadingHint &&
      Date.now() - lastChangeMs >= idleNeeded;
    if (quiet && (!sawGenerating || cur.images.length > 0)) {
      const total = Date.now() - start;
      const idleTail = Date.now() - lastChangeMs;
      run.log.info(`complete at +${total}ms (firstImage=${firstImageMs >= 0 ? firstImageMs + 'ms' : 'n/a'}, idleTail≈${idleTail}ms)`);
      return cur;
    }
  }
  run.log.warn(`response not stable within ${maxMs}ms, returning last observed state`);
  return last;
}

/**
 * 抓一张生成图，两层兜底：
 *   1. 页面内 fetch src → Blob → 合成 <a download> → download 事件 → run.saveDownload
 *   2. 点 ChatGPT 自带的图片下载按钮
 *
 * 为何不用 context().request.get：那条路从 Node 侧网络栈直连 CDN，本机环境下会解析到
 * 一个不可达的 IPv6（实测 connect ETIMEDOUT 2a03:2880:…），白白卡 ~21s 才回退。
 * 浏览器自身的网络栈能正常取到同源签名 URL，所以页面内 fetch 才是稳的快路径。
 */
async function saveImage(page: Page, run: Run, src: string, alt: string | undefined, index: number): Promise<ImageItem | null> {
  // 策略 1：页面内 fetch + 合成 <a download>
  try {
    const t = Date.now();
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    const mime = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const blob = await resp.blob();
        const obj = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = obj;
        a.download = 'brix-generated-image';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(obj); a.remove(); }, 10_000);
        return blob.type || 'image/png';
      } catch {
        return null;
      }
    }, src);

    if (mime) {
      const download = await downloadPromise;
      const suggested = download.suggestedFilename();
      const ext = (extname(suggested).toLowerCase() || mimeToExt(mime)) || '.png';
      const saved = await run.saveDownload(download, `image-${index}${ext}`);
      run.log.info(`fetched image #${index} ${saved.bytes} bytes -> ${saved.name} in ${Date.now() - t}ms`);
      return { index, alt, srcUrl: src, savedAs: saved.name, bytes: saved.bytes, suggestedFilename: suggested };
    }
    downloadPromise.catch(() => { /* ignore */ });
    run.log.warn(`in-page fetch failed for image #${index}, trying native download button`);
  } catch (e) {
    run.log.warn(`in-page fetch path failed for image #${index}: ${e instanceof Error ? e.message : e}`);
  }

  // 策略 2：点 ChatGPT 自带的图片下载按钮（末轮内）。
  // 只选"下载"专属入口 —— 不能用 `image-gen-overlay-actions button`，那会把点赞/点踩/
  // 编辑等按钮一起选中，再 .nth(index) 就点错（点到👍而非下载，永远等不到 download）。
  try {
    const assistant = page.locator('[data-testid^="conversation-turn"]').last();
    const dlBtn = assistant.locator(
      'button[aria-label*="下载"], button[aria-label*="Download"], a[download]',
    ).nth(index);
    if ((await dlBtn.count()) === 0) {
      run.log.warn(`no native download button for image #${index}`);
      return null;
    }
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      dlBtn.click({ timeout: 10_000 }),
    ]);
    const suggested = download.suggestedFilename();
    const ext = extname(suggested).toLowerCase() || '.png';
    const saved = await run.saveDownload(download, `image-${index}${ext}`);
    run.log.info(`downloaded image #${index} via button ${saved.bytes} bytes -> ${saved.name}`);
    return { index, alt, srcUrl: src, savedAs: saved.name, bytes: saved.bytes, suggestedFilename: suggested };
  } catch (e) {
    run.log.warn(`native download for image #${index} failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function downloadImages(page: Page, run: Run, found: GenImage[]): Promise<ImageItem[]> {
  run.log.info(`generated image count=${found.length}, downloading...`);
  const out: ImageItem[] = [];
  for (let i = 0; i < found.length; i++) {
    const item = await saveImage(page, run, found[i].src, found[i].alt, i);
    if (item) out.push(item);
  }
  return out;
}

async function uploadImages(page: Page, run: Run, images: UploadImageInput[]): Promise<string[]> {
  if (images.length === 0) return [];
  run.log.info(`uploading ${images.length} input image(s)`);

  // ChatGPT composer 里常驻一个隐藏的 <input type="file">，直接 setInputFiles 比走
  // "+" 菜单 → filechooser 稳：菜单项名/结构改版频繁，文件 input 反而稳定。
  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    paths.push(await run.writeArtifact(`upload-${i}${uploadExt(images[i])}`, decodeUploadImage(images[i])));
  }

  const fileInput = page.locator('input[data-testid="upload-photos-input"], input[type="file"]').first();
  try {
    await fileInput.waitFor({ state: 'attached', timeout: 10_000 });
    await fileInput.setInputFiles(paths);
  } catch (e) {
    throw new Error(`chatgpt-draw: file input not found / setInputFiles failed: ${e instanceof Error ? e.message : e}`);
  }

  // 上传后等缩略图就绪：过早发送会丢附件。等到附件预览出现或最多 15s。
  await page.locator('[data-testid*="attachment"], img[alt*="上传"], img[alt*="Uploaded"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => run.log.warn('attachment preview not detected; proceeding anyway'));
  await page.waitForTimeout(1_500);
  await snap(page, run, '01a-uploaded');
  return paths;
}

/**
 * best-effort 切到 "创建图片" 工具：点 composer 的 "+"，在菜单里点带 "图片/image" 的项。
 *
 * 不强制：gpt-4o 通常能直接从 prompt 文意触发画图，找不到 "+" 或菜单项就 warn 跳过，
 * 失败兜底按 Esc 关掉可能打开的菜单。
 */
async function selectImageMode(page: Page, run: Run): Promise<void> {
  run.log.info('best-effort selecting image tool: click "+" → 图片/Create image');
  const plus = page.locator(
    'button[data-testid="composer-plus-btn"], button[aria-label*="附加"], button[aria-label*="Add"], button[aria-label*="工具"]',
  ).first();
  try {
    await plus.waitFor({ state: 'visible', timeout: 5_000 });
    await plus.click();
    await page.waitForTimeout(400);
  } catch (e) {
    run.log.warn(`composer "+" not found, skip image tool: ${e instanceof Error ? e.message : e}`);
    return;
  }

  // 锚定真实文案"创建图片 / Create image"，别用裸 has-text("image")（会命中
  // "Search images"/"Edit image" 等任何含 image 的项而点错）。
  const item = page.locator(
    '[role="menuitem"]:has-text("创建图片"), [role="menuitemradio"]:has-text("创建图片"), [role="menuitem"]:has-text("生成图片"), [role="menuitem"]:has-text("图像"), [role="menuitem"]:has-text("Create image"), [role="menuitemradio"]:has-text("Create image")',
  ).first();
  try {
    await item.waitFor({ state: 'visible', timeout: 4_000 });
    await item.click();
    run.log.info('image tool selected');
  } catch (e) {
    run.log.warn(`image tool menu item not found: ${e instanceof Error ? e.message : e}`);
    await page.keyboard.press('Escape').catch(() => { /* ignore */ });
  }
  await page.waitForTimeout(400);
  await snap(page, run, '01b-image-mode');
}

/**
 * ChatGPT 入口常挂 Cloudflare Turnstile（"请验证您是真人" / "Just a moment"）。
 * 自动化浏览器会被挡在这里，看不到聊天 UI。这里 best-effort 处理：
 *   - 检测到挑战 → 轮询等它自动放行（patchright 反检测下 managed challenge 常能自过）
 *   - 顺便点一下 Turnstile iframe 里的复选框做 nudge
 * 最长等 maxMs；放行（出现输入框）即返回 true，超时返回 false。
 *
 * 注意：Cloudflare 对纯自动化指纹经常硬卡，过不去时正解是先用 open-profile 在同一
 * USER_DATA_DIR 手动过一次挑战 + 登录，cf_clearance/登录态留在 profile 后 serve 继承。
 */
async function dismissCloudflare(page: Page, run: Run, inputSel: string, maxMs = 60_000): Promise<boolean> {
  const isChallenge = async (): Promise<boolean> => {
    try {
      const hasInput = await page.locator(inputSel).first().isVisible().catch(() => false);
      if (hasInput) return false;
      return await page.evaluate(() => {
        const t = (document.title || '') + ' ' + (document.body?.textContent || '').slice(0, 400);
        if (/请稍候|请验证您是真人|Just a moment|Verify you are human|Checking your browser/i.test(t)) return true;
        return !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      });
    } catch { return false; }
  };

  if (!(await isChallenge())) return true;
  run.log.warn('Cloudflare challenge detected; waiting for it to clear (best-effort nudge)');
  await snap(page, run, '01-cloudflare');

  const start = Date.now();
  while (Date.now() - start < maxMs) {
    // nudge：点 Turnstile iframe 里的复选框（跨域 iframe，用 frameLocator）
    try {
      const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
      await frame.locator('input[type="checkbox"], label').first().click({ timeout: 2_000 });
      run.log.info('clicked Turnstile checkbox');
    } catch { /* iframe 不可点/已过 —— 忽略 */ }

    if (await page.locator(inputSel).first().isVisible().catch(() => false)) {
      run.log.info(`Cloudflare cleared after ${Date.now() - start}ms`);
      return true;
    }
    await page.waitForTimeout(2_000);
    if (!(await isChallenge())) {
      // 挑战消失但输入框还没出 —— 多给点时间让 SPA 渲染
      await page.waitForSelector(inputSel, { state: 'visible', timeout: 10_000 }).catch(() => { /* ignore */ });
      return await page.locator(inputSel).first().isVisible().catch(() => false);
    }
  }
  run.log.warn(`Cloudflare challenge not cleared within ${maxMs}ms`);
  return false;
}

async function extractLastResponseText(page: Page): Promise<string> {
  return (await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]'));
    const last = all[all.length - 1];
    return last ? (last.textContent || '').trim() : '';
  })) as string;
}

export async function runInSession(page: Page, args: unknown, run: Run): Promise<ChatGptOutput> {
  const { prompt, images: inputImages } = coerceArgs(args);
  const t0 = Date.now();
  // 各阶段耗时（ms），落到 result.json 便于定位优化点。
  const timings: Record<string, number> = {};
  let tPrev = t0;
  const mark = (name: string) => { const now = Date.now(); timings[name] = now - tPrev; tPrev = now; };
  run.log.info(`prompt="${prompt}" inputImages=${inputImages.length}`);

  // esbuild(tsx) 会给 page.evaluate 里的箭头/具名函数注入 __name(...) 包裹，浏览器
  // 上下文没有这个 helper 就 ReferenceError。注入恒等 shim：
  //   - addInitScript：覆盖之后每次导航（Cloudflare 过关后会 reload chatgpt 主框架）
  //   - evaluate(string)：覆盖当前已加载文档（字符串形式不会被 esbuild 改写）
  const NAME_SHIM = 'window.__name = window.__name || function(fn){return fn;};';
  await page.addInitScript(NAME_SHIM);

  // ChatGPT 页面有长连接（SSE），不等 networkidle，直接以输入框可用作为启动完成信号。
  const inputSel = 'div#prompt-textarea[contenteditable="true"], #prompt-textarea[contenteditable="true"]';
  if (!/^https?:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(page.url())) {
    run.log.info('not on chatgpt, goto chatgpt.com');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  await page.evaluate(NAME_SHIM).catch(() => { /* ignore */ });
  let inputReady = await page.waitForSelector(inputSel, { state: 'visible', timeout: 20_000 })
    .then(() => true).catch(() => false);
  // 没等到输入框：可能 Cloudflare 挑战，先尝试过墙。
  if (!inputReady) inputReady = await dismissCloudflare(page, run, inputSel);
  if (!inputReady) {
    await snap(page, run, '01-no-input');
    const loggedOut = await page.evaluate(
      () => /登录即可开始聊天|使用 Google 账户继续|使用 Apple 账户继续|Log in|Sign up/i.test(document.body?.textContent || ''),
    ).catch(() => false);
    throw new Error(loggedOut
      ? 'chatgpt-draw: 未登录 ChatGPT —— 请先停掉 serve，用 `npm run open-profile -- https://chatgpt.com` 在同一 profile 登录，关窗后重启 serve'
      : `chatgpt-draw: input box not found (Cloudflare 挑战未过?) at ${page.url()}`);
  }
  mark('nav');
  await snap(page, run, '01-loaded');

  // 登出态下 chatgpt.com landing 会闪一下 composer 再渲染登录页（#prompt-textarea
  // 转瞬即逝），上面的 20s wait 可能抓到这一瞬。这里再确认一次：若实际是登录页，
  // 早早带可执行指引退出，别走到后面发送时报含糊的 selector 超时。
  const loggedOutNow = await page.evaluate(
    () => /登录即可开始聊天|使用 Google 账户继续|使用 Apple 账户继续|Log in to start|Sign up/i.test(document.body?.textContent || ''),
  ).catch(() => false);
  if (loggedOutNow) {
    throw new Error('chatgpt-draw: 未登录 ChatGPT —— 请先停掉 serve，用 `npm run open-profile -- https://chatgpt.com` 在同一 profile 登录，关窗后重启 serve');
  }

  // 输入框/工具栏切模式后会重渲染 —— 用 Locator 而非 ElementHandle，每次 action 自动重解析。
  if (inputImages.length > 0) {
    const input = page.locator(inputSel).first();
    await input.click();
    await page.keyboard.press('Control+A').catch(() => { /* ignore */ });
    await page.keyboard.press('Delete').catch(() => { /* ignore */ });
  }
  await uploadImages(page, run, inputImages);
  mark('upload');

  // best-effort 切图片工具 —— 不依赖 ChatGPT 自动从 prompt 文意推断
  await selectImageMode(page, run);
  mark('selectImageMode');

  const baseline = await getState(page);
  run.log.info(`baseline assistantCount=${baseline.assistantCount}`);

  await page.waitForSelector(inputSel, { state: 'visible', timeout: 5_000 });
  const input = page.locator(inputSel).first();
  await input.click();
  if (inputImages.length === 0) {
    await page.keyboard.press('Control+A').catch(() => { /* ignore */ });
    await page.keyboard.press('Delete').catch(() => { /* ignore */ });
  }
  // 不用 keyboard.type：多行 prompt 里的换行会被当 Enter 提前发送，只发出第一段。
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(300);

  const sendBtn = page.locator('button[data-testid="send-button"]').first();
  try {
    await sendBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await sendBtn.click();
  } catch {
    // 发送按钮没找到 / 不可点：回退用 Enter 发送
    run.log.warn('send-button not clickable, falling back to Enter');
    await page.keyboard.press('Enter');
  }
  run.log.info('send triggered, waiting for response');
  await snap(page, run, '02-sent');
  mark('send');

  const final = await waitForResponseComplete(page, run, baseline.assistantCount);
  run.log.info(`response done: image=${final.images.length} text=${final.textLength} streaming=${final.streaming}`);
  mark('wait');
  // 不再单拍 03-response-done：末尾的 page.png/page.html 已捕获同一最终状态，
  // 省掉一次整页截图（长对话页 fullPage 截图要 ~10s）。

  const images = final.images.length > 0 ? await downloadImages(page, run, final.images) : [];
  const text = images.length === 0 ? await extractLastResponseText(page) : '';
  const mode: ChatGptOutput['mode'] = images.length > 0 ? 'image' : text ? 'text' : 'empty';
  mark('download');

  // 结果页 page.png/html 是诊断产物 —— 只 debug run 落盘；result.json + downloads/ 始终保留。
  if (run.debug) {
    const screenshot = await page.screenshot({ fullPage: true });
    await run.writeArtifact('page.png', screenshot);
    await run.writeArtifact('page.html', await page.content());
  }
  mark('finalize');

  const output: ChatGptOutput = {
    prompt,
    mode,
    images,
    text,
    finalUrl: page.url(),
    durationMs: Date.now() - t0,
    timings,
  };
  await run.writeArtifact('result.json', JSON.stringify({ runId: run.runId, ...output }, null, 2));
  run.log.info(`done in ${output.durationMs}ms mode=${mode} images=${images.length} timings=${JSON.stringify(timings)}`);
  return output;
}
