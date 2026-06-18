// 单步原语执行：在某个 session 的 tab 上跑一个浏览器原语（snapshot/click/fill/...）。
//
// 与 scripts 路由（跑一整个命名脚本）并列，是 LLM 探索期的入口：一次一个原语，看结果再
// 决定下一步。ref（snapshot 产生的 e1/e2）由 session 持有，跨多次调用存活，直到下次 snapshot 刷新。
//
// 复用 BrixScriptApi —— 把 session 的 ctx（第 4 参）和唯一交互 run 注进去，不重复实现任何浏览器逻辑。

import { createBrixScriptApi, type FileInput } from '../../scripts/api.js';
import {
  getSessionRefContext,
  getInteractiveRun,
  appendTrace,
  type BrixSession,
} from '../../sessions/registry.js';
import type { DownloadedFile } from '../../runs/run.js';

/** 参数/op 错误 → 400。 */
export class BadActionError extends Error {
  constructor(msg: string) { super(msg); this.name = 'BadActionError'; }
}

export interface ActionResult {
  runId: string;
  op: string;
  result?: unknown;
  snapshot?: { text: string; refCount: number };
  downloads?: DownloadedFile[];
}

/** 变更类 op：执行后页面可能变化，支持 returnSnapshot 顺带回刷新后的快照。 */
const MUTATING = new Set(['navigate', 'click', 'fill', 'type', 'press', 'select', 'hover', 'scroll', 'upload']);

type Body = Record<string, unknown>;

function str(body: Body, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0) throw new BadActionError(`${key} 必填（字符串）`);
  return v;
}
function optStr(body: Body, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}
function optNum(body: Body, key: string): number | undefined {
  const v = body[key];
  return typeof v === 'number' ? v : undefined;
}
function optBool(body: Body, key: string): boolean | undefined {
  const v = body[key];
  return typeof v === 'boolean' ? v : undefined;
}

/** 轨迹参数摘要：去掉控制字段与文件字节，避免把 base64 大图塞进 trace。 */
function sanitizeParams(body: Body): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'op' || k === 'debug' || k === 'returnSnapshot') continue;
    if (k === 'file' || k === 'files') { out[k] = '[file]'; continue; }
    if (k === 'source' && typeof v === 'string' && v.length > 200) { out[k] = `${v.slice(0, 200)}…`; continue; }
    out[k] = v;
  }
  return out;
}

function summarize(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === 'string') return result.length > 120 ? `${result.slice(0, 120)}…` : result;
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  try {
    const s = JSON.stringify(result);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch { return undefined; }
}

/**
 * 在 session 上执行一个原语。成功返回 ActionResult，参数错误抛 BadActionError，
 * 其余错误（脚本/浏览器层）原样抛出由路由映射成 script_failed。
 *
 * 调用方应已用 withSessionLock 包裹本调用以保证单 session 串行。
 */
export async function executeAction(session: BrixSession, body: Body): Promise<ActionResult> {
  const op = optStr(body, 'op');
  if (!op) throw new BadActionError('op 必填');

  const ctx = getSessionRefContext(session);
  const run = await getInteractiveRun(session, optBool(body, 'debug'));
  const brix = createBrixScriptApi(session.page, run, undefined, ctx);

  let result: unknown;
  let snapshot: { text: string; refCount: number } | undefined;
  let downloads: DownloadedFile[] | undefined;

  try {
    switch (op) {
      case 'navigate':
        await brix.goto(str(body, 'url'), {
          waitUntil: optStr(body, 'waitUntil') as 'load' | 'domcontentloaded' | 'networkidle' | undefined,
          timeout: optNum(body, 'timeout'),
        });
        break;
      case 'snapshot':
        // 只放 snapshot 字段，不重复进 result（省一份快照文本）。
        snapshot = await brix.snapshot({
          scope: optStr(body, 'scope'),
          interactiveOnly: optBool(body, 'interactiveOnly'),
          maxDepth: optNum(body, 'maxDepth'),
        });
        break;
      case 'click': {
        const target = str(body, 'target');
        const timeout = optNum(body, 'timeout');
        const optional = optBool(body, 'optional');
        if (optBool(body, 'expectDownload')) {
          const handle = await brix.captureDownload(() => brix.click(target, { timeout, optional }), { timeout });
          result = await brix.saveDownload(handle, optStr(body, 'saveAs'));
          downloads = await run.listDownloads();
        } else {
          await brix.click(target, { timeout, optional });
        }
        break;
      }
      case 'fill':
        await brix.fill(str(body, 'target'), str(body, 'value'));
        break;
      case 'type':
        await brix.type(str(body, 'target'), str(body, 'value'), { delay: optNum(body, 'delay') });
        break;
      case 'press':
        await brix.press(str(body, 'key'));
        break;
      case 'select':
        await brix.select(str(body, 'target'), body.value as string | string[]);
        break;
      case 'hover':
        await brix.hover(str(body, 'target'), { timeout: optNum(body, 'timeout') });
        break;
      case 'scroll':
        await brix.scroll((optStr(body, 'direction') ?? 'down') as 'up' | 'down', optNum(body, 'amount'));
        break;
      case 'upload': {
        const file = (body.file ?? body.files) as FileInput | FileInput[] | undefined;
        if (!file) throw new BadActionError('upload 需要 file 或 files');
        await brix.setInputFiles(str(body, 'target'), file);
        break;
      }
      case 'eval':
        result = await brix.evalInPage(str(body, 'source'));
        break;
      case 'waitForSelector':
        await brix.waitForSelector(str(body, 'selector'), {
          state: optStr(body, 'state') as 'attached' | 'detached' | 'visible' | 'hidden' | undefined,
          timeout: optNum(body, 'timeout'),
        });
        break;
      case 'waitForLoad':
        await brix.waitForLoad(
          optStr(body, 'state') as 'load' | 'domcontentloaded' | 'networkidle' | undefined,
          { timeout: optNum(body, 'timeout') },
        );
        break;
      case 'waitForUrl':
        await brix.waitForUrl(str(body, 'pattern'), { timeout: optNum(body, 'timeout') });
        break;
      case 'text':
        result = await brix.text(str(body, 'selector'));
        break;
      case 'attr':
        result = await brix.attr(str(body, 'selector'), str(body, 'name'));
        break;
      case 'count':
        result = await brix.count(str(body, 'selector'));
        break;
      case 'content':
        result = await brix.content();
        break;
      case 'url':
        result = brix.url();
        break;
      case 'title':
        result = await brix.title();
        break;
      case 'screenshot': {
        const png = await brix.screenshot({ fullPage: optBool(body, 'fullPage') });
        result = { base64: png.toString('base64'), mimeType: 'image/png' };
        break;
      }
      default:
        throw new BadActionError(`未知 op: ${op}`);
    }

    // 变更类 op 按需回刷新后的快照（让 LLM 拿到新 refs 接着干）。放 try 内，
    // 这步失败也走失败 trace + 统一报错路径。
    if (!snapshot && MUTATING.has(op) && optBool(body, 'returnSnapshot')) {
      snapshot = await brix.snapshot();
    }
  } catch (e) {
    // 只记真正触达页面/浏览器的失败；参数校验错（BadActionError）不进 trace —— trace 是
    // "我实际跑过的序列"，用于固化，不该被 400 噪声污染。
    if (!(e instanceof BadActionError)) {
      appendTrace(session, { ts: Date.now(), op, params: sanitizeParams(body), ok: false, resultSummary: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  }

  const okSummary = op === 'screenshot' ? '[png]' : op === 'snapshot' ? `refs=${snapshot?.refCount ?? 0}` : summarize(result);
  appendTrace(session, { ts: Date.now(), op, params: sanitizeParams(body), ok: true, resultSummary: okSummary });

  return { runId: run.runId, op, result, snapshot, downloads };
}
