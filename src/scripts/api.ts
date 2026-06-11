// BrixScriptApi：注入到 .js 脚本里的唯一运行时入口。
//
// 设计原则：
//   - 脚本里能调到的所有浏览器/文件系统/产物落地能力，都从这里走。
//   - 不暴露 Page 句柄 —— 脚本拿不到原生 Playwright API，杜绝 page.context() / setInputFiles(任意路径) 这类口子。
//   - 不暴露 Run 句柄 —— 脚本拿不到 dir 路径，writeArtifact/saveDownload 由 api 包装并校验文件名。
//   - evalInPage 接受字符串（不接受 function），这是核心能力刻意保留，但要求作者意识到跨进程边界。
//
// ref 解析：PR 1 仍走 Node 侧 BrowserRefContext（与现状一致），PR 2 改成 page-side WeakMap。
// 这里 ctx 是 BrixScriptApi 实例私有的，所以同一 run 内 snapshot → click(ref) 链路通畅；
// 多次 snapshot 会重置 ctx，旧 ref 失效。

import type { Download, Page, ElementHandle } from 'patchright';
import { extname } from 'node:path';
import type { Run } from '../runs/run.js';
import type { Logger } from '../utils/logger.js';
import { createBrowserRefContext, takeSnapshot, type BrowserRefContext, type FormatOptions } from '../browser/snapshot.js';

const REF_RE = /^e\d+$/;

export interface SnapshotOpts {
  scope?: string;
  interactiveOnly?: boolean;
  maxDepth?: number;
}

export interface SnapshotResult {
  text: string;
  refCount: number;
}

export interface FileInput {
  /** 文件名（必填，纯名字，不含路径） */
  filename: string;
  /** base64 字符串（不含 data:image/...,前缀），或 dataURL，或 raw bytes（Uint8Array） */
  base64?: string;
  dataUrl?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}

export interface DownloadHandle {
  /** Playwright Download 句柄；不应被脚本访问，仅作为 captureDownload → saveDownload 的传递 */
  readonly _internal: Download;
  /** Chrome 建议的文件名（脚本可读） */
  suggestedFilename: string;
}

export interface SavedDownload {
  name: string;
  bytes: number;
  mimeType: string;
}

export interface ClickOpts {
  timeout?: number;
  /** 元素未找到不报错（false 时仍按 Playwright 默认报错） */
  optional?: boolean;
}

export interface BrixScriptApi {
  /** 调用方原样传入的 args */
  readonly args: unknown;
  /** 当前 run 的日志器；写入 brix 日志流，调用方拿不到 */
  readonly log: Logger;
  /** 路径工具（只暴露最常用的，避免脚本作者 import 'node:path'） */
  readonly path: { ext(name: string): string };

  // ---- 导航 / 页面状态 ----
  /** 当前页面 URL */
  url(): string;
  /** 当前页面 title */
  title(): Promise<string>;
  /** 当前页面 HTML 全文 */
  content(): Promise<string>;
  /** 导航到 url；默认 waitUntil='domcontentloaded' */
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<void>;
  /** 等 networkidle / load 等 */
  waitForLoad(state?: 'load' | 'domcontentloaded' | 'networkidle', opts?: { timeout?: number }): Promise<void>;
  /** 等 URL 匹配 */
  waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  /** sleep ms */
  sleep(ms: number): Promise<void>;

  // ---- DOM 快照与查询 ----
  /** 抓 snapshot；同一 run 内多次调用会重置 refMap */
  snapshot(opts?: SnapshotOpts): Promise<SnapshotResult>;
  /**
   * 在页面里执行一段 JS（字符串形式）。返回值通过 JSON 序列化跨进程传回，所以
   * 不要返回 DOM 节点 / Function / 循环引用。
   *
   * 这是 brix 刻意保留的核心能力 —— 抓 DOM 状态、做复杂查询都靠它。
   */
  evalInPage<T = unknown>(source: string): Promise<T>;
  /** 等元素出现 */
  waitForSelector(selector: string, opts?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  /** 查元素数量 */
  count(selector: string): Promise<number>;
  /** 取属性 */
  attr(selector: string, name: string): Promise<string | null>;
  /** 取文本 */
  text(selector: string): Promise<string>;

  // ---- 交互 ----
  /**
   * 点击。input 可以是 selector 或 ref（形如 "e3"，需先调用 snapshot 拿到）。
   * 当前 PR 用 Node 侧 refMap 解析；PR 2 会改成 page-side WeakMap，API 不变。
   */
  click(refOrSelector: string, opts?: ClickOpts): Promise<void>;
  /** 填入（覆盖已有内容） */
  fill(selector: string, value: string): Promise<void>;
  /** 键入（逐字符） */
  type(selector: string, value: string, opts?: { delay?: number }): Promise<void>;
  /** 按键 */
  press(key: string): Promise<void>;
  /**
   * 给 input[type=file] 投文件。input 内容必须来自 args（base64/dataUrl/bytes），
   * **不接受宿主文件系统路径**（这是现有 google-lens imagePath 的口子，新 API 关掉）。
   */
  setInputFiles(selector: string, file: FileInput | FileInput[]): Promise<void>;

  // ---- 下载 ----
  /**
   * 触发下载：传入 triggerFn 是会触发 download 事件的动作（通常是 brix.click(...)）。
   * 等 Playwright 拿到 download 句柄后返回 DownloadHandle，脚本再调 saveDownload 落地。
   */
  captureDownload(triggerFn: () => Promise<void>, opts?: { timeout?: number }): Promise<DownloadHandle>;
  /** 把下载落到 run/downloads/，可通过 HTTP /runs/:id/files 取 */
  saveDownload(handle: DownloadHandle, name?: string): Promise<SavedDownload>;

  // ---- 产物 ----
  /** 整页截图（PNG bytes）—— 不落地，由脚本自行决定写到哪 */
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>;
  /** 阶段诊断快照：截图 + HTML + log 一把梭，落到 run.dir/stage-<tag>.* */
  snap(tag: string): Promise<void>;
  /** 写产物到 run.dir/（不走 HTTP；通过 HTTP 暴露只能 saveDownload） */
  writeArtifact(name: string, data: Buffer | string): Promise<void>;
}

/** session 路由用：从 page + run + args 构造一个 BrixScriptApi */
export function createBrixScriptApi(page: Page, run: Run, args: unknown): BrixScriptApi {
  let ctx: BrowserRefContext = createBrowserRefContext();

  const resolveSelector = async (refOrSelector: string): Promise<string> => {
    if (REF_RE.test(refOrSelector)) {
      const entry = ctx.refMap.get(refOrSelector);
      if (!entry) {
        throw new Error(`brix: ref "${refOrSelector}" 不存在 —— 请先调用 brix.snapshot()`);
      }
      if (!entry.selector) {
        throw new Error(`brix: ref "${refOrSelector}" 无 selector（角色 ${entry.role}）`);
      }
      return entry.selector;
    }
    return refOrSelector;
  };

  // 给 setInputFiles 用：把 FileInput 解码成 Playwright 接受的 { name, mimeType, buffer }
  const decodeFile = (f: FileInput): { name: string; mimeType: string; buffer: Buffer } => {
    if (!f.filename || typeof f.filename !== 'string') {
      throw new Error('brix.setInputFiles: filename 必填');
    }
    let buffer: Buffer;
    if (f.bytes instanceof Uint8Array) {
      buffer = Buffer.from(f.bytes);
    } else if (typeof f.dataUrl === 'string') {
      const m = /^data:([^;,]+);base64,(.*)$/.exec(f.dataUrl);
      if (!m) throw new Error('brix.setInputFiles: dataUrl 格式不对（要求 base64）');
      buffer = Buffer.from(m[2], 'base64');
    } else if (typeof f.base64 === 'string') {
      buffer = Buffer.from(f.base64, 'base64');
    } else {
      throw new Error('brix.setInputFiles: 需要 bytes / base64 / dataUrl 之一');
    }
    const mimeType = f.mimeType || 'application/octet-stream';
    return { name: f.filename, mimeType, buffer };
  };

  return {
    args,
    log: run.log,
    path: { ext: (n: string) => extname(n) },

    url: () => page.url(),
    title: () => page.title(),
    content: () => page.content(),
    async goto(url, opts) {
      await page.goto(url, {
        waitUntil: opts?.waitUntil ?? 'domcontentloaded',
        timeout: opts?.timeout ?? 30_000,
      });
    },
    async waitForLoad(state, opts) {
      await page.waitForLoadState(state ?? 'load', { timeout: opts?.timeout ?? 10_000 });
    },
    async waitForUrl(pattern, opts) {
      await page.waitForURL(pattern, { timeout: opts?.timeout ?? 30_000 });
    },
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),

    async snapshot(opts) {
      ctx = createBrowserRefContext();
      const { scope, ...rest } = opts ?? {};
      const formatOpts: Partial<FormatOptions> = {};
      if (typeof rest.interactiveOnly === 'boolean') formatOpts.interactiveOnly = rest.interactiveOnly;
      if (typeof rest.maxDepth === 'number') formatOpts.maxDepth = rest.maxDepth;
      const text = await takeSnapshot(page, scope, ctx, formatOpts);
      return { text, refCount: ctx.refCounter };
    },
    async evalInPage<T>(source: string): Promise<T> {
      if (typeof source !== 'string') {
        throw new Error('brix.evalInPage: source 必须是字符串');
      }
      return (await page.evaluate(source)) as T;
    },
    async waitForSelector(selector, opts) {
      await page.waitForSelector(selector, {
        state: opts?.state ?? 'visible',
        timeout: opts?.timeout ?? 10_000,
      });
    },
    count: (selector) => page.locator(selector).count(),
    async attr(selector, name) {
      return page.locator(selector).first().getAttribute(name);
    },
    async text(selector) {
      return (await page.locator(selector).first().textContent()) ?? '';
    },

    async click(refOrSelector, opts) {
      const sel = await resolveSelector(refOrSelector);
      try {
        await page.click(sel, { timeout: opts?.timeout ?? 10_000 });
      } catch (e) {
        if (opts?.optional) {
          run.log.debug(`click "${sel}" optional miss: ${e instanceof Error ? e.message : e}`);
          return;
        }
        throw e;
      }
    },
    async fill(selector, value) {
      await page.locator(selector).first().fill(value);
    },
    async type(selector, value, opts) {
      const loc = page.locator(selector).first();
      await loc.click();
      await loc.pressSequentially(value, { delay: opts?.delay ?? 8 });
    },
    async press(key) {
      await page.keyboard.press(key);
    },
    async setInputFiles(selector, file) {
      const files = Array.isArray(file) ? file.map(decodeFile) : [decodeFile(file)];
      const handle = await page.waitForSelector(selector, { state: 'attached', timeout: 15_000 });
      // ElementHandle.setInputFiles 接受 { name, mimeType, buffer }
      await (handle as ElementHandle<HTMLInputElement>).setInputFiles(files);
    },

    async captureDownload(triggerFn, opts) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: opts?.timeout ?? 30_000 }),
        triggerFn(),
      ]);
      return { _internal: download, suggestedFilename: download.suggestedFilename() };
    },
    async saveDownload(handle, name) {
      const saved = await run.saveDownload(handle._internal, name);
      return { name: saved.name, bytes: saved.bytes, mimeType: saved.mimeType };
    },

    async screenshot(opts) {
      return await page.screenshot({ fullPage: opts?.fullPage ?? true });
    },
    async snap(tag) {
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(tag)) {
        throw new Error(`brix.snap: tag 必须匹配 [A-Za-z0-9._-]{1,80}，收到 "${tag}"`);
      }
      // 调试产物：非 debug run 直接跳过，省截图/HTML 落盘。
      if (!run.debug) return;
      try {
        const png = await page.screenshot({ fullPage: true });
        await run.writeArtifact(`stage-${tag}.png`, png);
      } catch (e) {
        run.log.debug(`snap png failed: ${e instanceof Error ? e.message : e}`);
      }
      try {
        const html = await page.content();
        await run.writeArtifact(`stage-${tag}.html`, html);
      } catch (e) {
        run.log.debug(`snap html failed: ${e instanceof Error ? e.message : e}`);
      }
      run.log.info(`stage=${tag}`);
    },
    async writeArtifact(name, data) {
      await run.writeArtifact(name, data);
    },
  };
}
