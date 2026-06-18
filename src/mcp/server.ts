// brix-mcp：把 brix 的浏览器原语统一暴露给 LLM 的 stdio MCP server。
//
// 两阶段流水线：
//   探索期 —— LLM 用 browser_* 原语一步步驱动某个 session 的 tab，ref（snapshot 产生的
//             e1/e2）跨调用存活；其间人可随时在有头共享窗口里手动介入（brix 不定策略，
//             调用方自行决定何时暂停发动作）。
//   固化期 —— 走通后用 script_save 把序列写成 .js，之后 script_run 直接调用。
//
// 本 server 不碰浏览器，只经 HTTP 调 brix（见 client.ts）。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { brixFetch, brixJson, brixPost, BrixHttpError } from './client.js';

const CHARACTER_LIMIT = 25_000;

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
interface ToolResult { content: Content[]; isError?: boolean; [x: string]: unknown }

interface ActionResult {
  runId: string;
  op: string;
  result?: unknown;
  snapshot?: { text: string; refCount: number };
  downloads?: Array<{ name: string; bytes: number; mimeType: string }>;
}

// ---- 格式化 / 错误处理 helper ----

function clip(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return `${text.slice(0, CHARACTER_LIMIT)}\n…[truncated ${text.length - CHARACTER_LIMIT} chars]`;
}
function text(s: string): ToolResult { return { content: [{ type: 'text', text: clip(s) }] }; }
function errText(s: string): ToolResult { return { content: [{ type: 'text', text: s }], isError: true }; }

/** 统一捕获：BrixHttpError → 可读的后端错误，其余 → 通用错误。 */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof BrixHttpError) return errText(`brix HTTP ${e.status}: ${e.message}`);
    return errText(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 把一次 action 的结果转成 MCP content：摘要文本 + 可选快照 + 截图图块。 */
function formatAction(r: ActionResult): ToolResult {
  const content: Content[] = [];
  const lines: string[] = [`op=${r.op} run=${r.runId}`];
  if (r.result !== undefined && r.op !== 'screenshot' && r.op !== 'snapshot') {
    lines.push(`result: ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}`);
  }
  if (r.downloads?.length) {
    lines.push(`downloads: ${r.downloads.map((d) => `${d.name} (${d.bytes}B)`).join(', ')}`);
    lines.push(`  取文件用 run_file_get { runId: "${r.runId}", name: "..." }`);
  }
  content.push({ type: 'text', text: clip(lines.join('\n')) });
  if (r.snapshot) content.push({ type: 'text', text: clip(r.snapshot.text) });
  if (r.op === 'screenshot' && r.result && typeof r.result === 'object') {
    const s = r.result as { base64?: string; mimeType?: string };
    if (s.base64) content.push({ type: 'image', data: s.base64, mimeType: s.mimeType ?? 'image/png' });
  }
  return { content };
}

const enc = encodeURIComponent;

/** 发一个 action 并格式化。所有 browser_* 与 browser_action 走这里。 */
async function runAction(sessionId: string, body: Record<string, unknown>): Promise<ToolResult> {
  const r = await brixPost<ActionResult>(`/sessions/${enc(sessionId)}/actions`, body);
  return formatAction(r);
}

// 公共字段
const sid = z.string().min(1).describe('session id（由 session_open 返回）');
const target = z.string().min(1).describe('元素定位：ref（如 "e3"，需先 browser_snapshot）或 CSS selector');
const returnSnapshot = z.boolean().optional().describe('变更后顺带返回刷新的页面快照（含新 refs），默认 false');

const RO = { readOnlyHint: true, openWorldHint: true } as const;
const RW = { readOnlyHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'brix-mcp-server', version: '0.1.0' });

  // ============ 会话生命周期 ============

  server.registerTool('session_open', {
    title: 'Open browser session',
    description: `在 brix 的常驻 Chrome 里开一个新 tab（session），可选直接打开 url。返回 { sessionId, url }。
所有 browser_* 原语和 script_run 都在某个 session 上执行。session 一直保持到你 session_close 或 brix 空闲超时。
人工介入（登录/过验证）就在这个有头共享 tab 里做 —— 你暂停发动作、人手动操作、完成后你继续即可。`,
    inputSchema: { url: z.string().optional().describe('开 tab 后立即打开的 url（可选）') },
    annotations: RW,
  }, async ({ url }) => guard(async () => {
    const r = await brixPost<{ sessionId: string; url: string }>('/sessions', url ? { url } : {});
    return text(`session opened: ${r.sessionId}\nurl: ${r.url}`);
  }));

  server.registerTool('session_list', {
    title: 'List sessions',
    description: '列出当前所有活动 session：{ sessionId, url, createdAt, lastActiveAt }[]。',
    inputSchema: {},
    annotations: RO,
  }, async () => guard(async () => text(JSON.stringify(await brixJson('/sessions'), null, 2))));

  server.registerTool('session_close', {
    title: 'Close session',
    description: '关闭一个 session（关 tab）。幂等：不存在返回未找到。',
    inputSchema: { sessionId: sid },
    annotations: DESTRUCTIVE,
  }, async ({ sessionId }) => guard(async () => {
    const res = await brixFetch(`/sessions/${enc(sessionId)}`, { method: 'DELETE' });
    return res.status === 204 ? text(`closed ${sessionId}`) : errText(`close failed: HTTP ${res.status}`);
  }));

  server.registerTool('session_trace', {
    title: 'Get action trace',
    description: `返回某 session 上你执行过的原语序列（封顶最近 200 条）：{ ts, op, params, ok, resultSummary }[]。
用于固化前回看自己走通的步骤 —— 据此用 script_save 写成 .js。brix 不替你生成代码。`,
    inputSchema: { sessionId: sid },
    annotations: RO,
  }, async ({ sessionId }) => guard(async () => {
    const r = await brixJson<{ trace: unknown[] }>(`/sessions/${enc(sessionId)}/trace`);
    return text(JSON.stringify(r.trace, null, 2));
  }));

  // ============ 交互原语（探索期）============

  server.registerTool('browser_navigate', {
    title: 'Navigate',
    description: '在 session 的 tab 上导航到 url。',
    inputSchema: {
      sessionId: sid,
      url: z.string().min(1).describe('目标 url'),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe('等待时机，默认 domcontentloaded'),
      returnSnapshot,
    },
    annotations: RW,
  }, async ({ sessionId, ...p }) => guard(() => runAction(sessionId, { op: 'navigate', ...p })));

  server.registerTool('browser_snapshot', {
    title: 'Snapshot page',
    description: `抓当前页面的结构化无障碍快照，可交互元素带 [ref=eN] 标记。后续 browser_click/fill/...
用这些 ref 定位元素；ref 在本 session 内一直有效，直到下次 snapshot 刷新。这是探索的"看"。`,
    inputSchema: {
      sessionId: sid,
      scope: z.string().optional().describe('CSS selector，只抓该子树（可选）'),
      interactiveOnly: z.boolean().optional().describe('只输出可交互节点，默认 false'),
      maxDepth: z.number().int().min(0).optional().describe('最大嵌套深度，0=不限'),
    },
    annotations: RO,
  }, async ({ sessionId, ...p }) => guard(() => runAction(sessionId, { op: 'snapshot', ...p })));

  server.registerTool('browser_click', {
    title: 'Click',
    description: `点击一个元素（ref 或 selector）。expectDownload=true 时把点击触发的下载落到本 session 的 run，
返回文件元数据（再用 run_file_get 取字节）。`,
    inputSchema: {
      sessionId: sid,
      target,
      optional: z.boolean().optional().describe('元素不存在也不报错，默认 false'),
      timeout: z.number().int().optional().describe('超时 ms'),
      expectDownload: z.boolean().optional().describe('点击会触发下载，捕获并落盘'),
      saveAs: z.string().optional().describe('下载另存的文件名（配合 expectDownload）'),
      returnSnapshot,
    },
    annotations: RW,
  }, async ({ sessionId, ...p }) => guard(() => runAction(sessionId, { op: 'click', ...p })));

  server.registerTool('browser_fill', {
    title: 'Fill',
    description: '在输入框/可编辑元素里覆盖填入文本（ref 或 selector）。',
    inputSchema: { sessionId: sid, target, value: z.string().describe('要填入的值'), returnSnapshot },
    annotations: RW,
  }, async ({ sessionId, ...p }) => guard(() => runAction(sessionId, { op: 'fill', ...p })));

  server.registerTool('browser_type', {
    title: 'Type',
    description: '逐字符键入（适合需要触发 keydown 的输入；ref 或 selector）。',
    inputSchema: {
      sessionId: sid, target, value: z.string().describe('要键入的文本'),
      delay: z.number().int().optional().describe('每字符间隔 ms'), returnSnapshot,
    },
    annotations: RW,
  }, async ({ sessionId, ...p }) => guard(() => runAction(sessionId, { op: 'type', ...p })));

  server.registerTool('browser_press', {
    title: 'Press key',
    description: '按一个键（如 "Enter"、"Escape"、"Control+A"）。',
    inputSchema: { sessionId: sid, key: z.string().min(1).describe('键名'), returnSnapshot },
    annotations: RW,
  }, async ({ sessionId, ...p }) => guard(() => runAction(sessionId, { op: 'press', ...p })));

  server.registerTool('browser_select', {
    title: 'Select option',
    description: '在 <select> 上选项（ref 或 selector）；value 单值或多值。',
    inputSchema: {
      sessionId: sid, target,
      value: z.union([z.string(), z.array(z.string())]).describe('选项 value'), returnSnapshot,
    },
    annotations: RW,
  }, async ({ sessionId, ...p }) => guard(() => runAction(sessionId, { op: 'select', ...p })));

  server.registerTool('browser_hover', {
    title: 'Hover',
    description: '悬停到元素（ref 或 selector）。',
    inputSchema: { sessionId: sid, target, timeout: z.number().int().optional(), returnSnapshot },
    annotations: RW,
  }, async ({ sessionId, ...p }) => guard(() => runAction(sessionId, { op: 'hover', ...p })));

  server.registerTool('browser_scroll', {
    title: 'Scroll',
    description: '滚动当前页面（鼠标滚轮）。',
    inputSchema: {
      sessionId: sid,
      direction: z.enum(['up', 'down']).describe('方向'),
      amount: z.number().int().optional().describe('像素，默认 500'), returnSnapshot,
    },
    annotations: RW,
  }, async ({ sessionId, ...p }) => guard(() => runAction(sessionId, { op: 'scroll', ...p })));

  server.registerTool('browser_upload', {
    title: 'Upload files',
    description: `给 <input type=file> 投文件。文件内容用 base64/dataUrl 传（不接受宿主文件系统路径）。`,
    inputSchema: {
      sessionId: sid, target,
      files: z.array(z.object({
        filename: z.string().describe('文件名'),
        base64: z.string().optional().describe('base64（不含 data: 前缀）'),
        dataUrl: z.string().optional().describe('data:<mime>;base64,... '),
        mimeType: z.string().optional(),
      })).min(1).describe('要投的文件'),
    },
    annotations: RW,
  }, async ({ sessionId, target: t, files }) => guard(() => runAction(sessionId, { op: 'upload', target: t, files })));

  server.registerTool('browser_eval', {
    title: 'Eval JS in page',
    description: `在页面上下文执行一段 JS（字符串），返回 JSON 可序列化的结果。抓 DOM 状态、做复杂查询用它。
不要返回 DOM 节点/函数/循环引用。`,
    inputSchema: { sessionId: sid, source: z.string().min(1).describe('要执行的 JS 源码（表达式或 IIFE）') },
    annotations: RW,
  }, async ({ sessionId, source }) => guard(() => runAction(sessionId, { op: 'eval', source })));

  server.registerTool('browser_wait', {
    title: 'Wait',
    description: '等待条件：kind=selector（等元素）/ load（等加载态）/ url（等 URL 匹配）。',
    inputSchema: {
      sessionId: sid,
      kind: z.enum(['selector', 'load', 'url']).describe('等待类型'),
      selector: z.string().optional().describe('kind=selector 时的 CSS selector'),
      state: z.string().optional().describe('selector: attached|detached|visible|hidden；load: load|domcontentloaded|networkidle'),
      pattern: z.string().optional().describe('kind=url 时的匹配（字符串/glob）'),
      timeout: z.number().int().optional(),
    },
    annotations: RO,
  }, async ({ sessionId, kind, selector, state, pattern, timeout }) => guard(() => {
    if (kind === 'selector') return runAction(sessionId, { op: 'waitForSelector', selector, state, timeout });
    if (kind === 'url') return runAction(sessionId, { op: 'waitForUrl', pattern, timeout });
    return runAction(sessionId, { op: 'waitForLoad', state, timeout });
  }));

  server.registerTool('browser_read', {
    title: 'Read page value',
    description: `读取页面信息：what=text|attr|count（需 selector，attr 还需 name）或 content|url|title（整页/当前）。
content 返回整页 HTML（可能很大，已截断）。`,
    inputSchema: {
      sessionId: sid,
      what: z.enum(['text', 'attr', 'count', 'content', 'url', 'title']).describe('读取目标'),
      selector: z.string().optional().describe('text/attr/count 需要'),
      name: z.string().optional().describe('attr 的属性名'),
    },
    annotations: RO,
  }, async ({ sessionId, what, selector, name }) => guard(() => runAction(sessionId, { op: what, selector, name })));

  server.registerTool('browser_screenshot', {
    title: 'Screenshot',
    description: '整页截图，返回 PNG 图块（直接看图）。',
    inputSchema: { sessionId: sid, fullPage: z.boolean().optional().describe('整页（默认 true）') },
    annotations: RO,
  }, async ({ sessionId, fullPage }) => guard(() => runAction(sessionId, { op: 'screenshot', fullPage })));

  server.registerTool('browser_action', {
    title: 'Raw action (escape hatch)',
    description: `透传任意 action op 到 brix /actions —— 当上面具名 tool 没覆盖到某个 op，或要传新参数时用。
body = { op, ...params }。返回同 browser_* 的格式。`,
    inputSchema: {
      sessionId: sid,
      op: z.string().min(1).describe('action op 名'),
      params: z.record(z.unknown()).optional().describe('该 op 的参数对象'),
      returnSnapshot,
    },
    annotations: RW,
  }, async ({ sessionId, op, params, returnSnapshot: rs }) =>
    guard(() => runAction(sessionId, { op, ...(params ?? {}), returnSnapshot: rs })));

  // ============ 脚本（固化 + 生产）============

  server.registerTool('script_list', {
    title: 'List scripts',
    description: '列出已保存脚本：{ name, description?, argsExample?, bytes, createdAt, updatedAt }[]。',
    inputSchema: {},
    annotations: RO,
  }, async () => guard(async () => text(JSON.stringify(await brixJson('/scripts'), null, 2))));

  server.registerTool('script_get', {
    title: 'Get script',
    description: '读一个脚本的源码与元数据：{ meta, source }。',
    inputSchema: { name: z.string().min(1) },
    annotations: RO,
  }, async ({ name }) => guard(async () => text(JSON.stringify(await brixJson(`/scripts/${enc(name)}`), null, 2))));

  server.registerTool('script_save', {
    title: 'Save script (crystallize)',
    description: `把走通的流程固化成脚本（PUT /scripts/:name）。这是探索→固化的落点：你按 brix-api 约定写
export async function runInSession(brix){...}（用 brix.goto/snapshot/click/fill/... 复现探索步骤），
存进去后即可 script_run 直接调用。写前 brix 做语法/AST 校验，失败返回 bad_script。
name 规则：^[a-z0-9][a-z0-9-]{0,63}$。`,
    inputSchema: {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'name 须匹配 ^[a-z0-9][a-z0-9-]{0,63}$'),
      source: z.string().min(1).max(1_000_000).describe('脚本源码（brix-api 约定，默认 .js）'),
      language: z.enum(['js', 'ts']).optional().describe('默认 js（新约定）'),
    },
    annotations: RW,
  }, async ({ name, source, language }) => guard(async () => {
    const r = await brixJson(`/scripts/${enc(name)}`, {
      method: 'PUT', body: JSON.stringify(language ? { source, language } : { source }),
    });
    return text(`saved ${name}\n${JSON.stringify(r, null, 2)}`);
  }));

  server.registerTool('script_delete', {
    title: 'Delete script',
    description: '删除一个脚本。',
    inputSchema: { name: z.string().min(1) },
    annotations: DESTRUCTIVE,
  }, async ({ name }) => guard(async () => {
    const res = await brixFetch(`/scripts/${enc(name)}`, { method: 'DELETE' });
    return res.ok || res.status === 204 ? text(`deleted ${name}`) : errText(`delete failed: HTTP ${res.status}`);
  }));

  server.registerTool('script_run', {
    title: 'Run script (production)',
    description: `在某 session 上跑一个已保存脚本（同步等完成）。返回 { runId, output, downloads }。
固化后的生产期入口。下载用 run_file_get 取。`,
    inputSchema: {
      sessionId: sid,
      name: z.string().min(1).describe('脚本名'),
      args: z.unknown().optional().describe('传给脚本的参数（任意 JSON）'),
    },
    annotations: RW,
  }, async ({ sessionId, name, args }) => guard(async () => {
    const r = await brixPost<{ runId: string; output: unknown; downloads: unknown[] }>(
      `/sessions/${enc(sessionId)}/scripts/${enc(name)}`, { args });
    return text(JSON.stringify(r, null, 2));
  }));

  // ============ run 产物 ============

  server.registerTool('run_files_list', {
    title: 'List run files',
    description: '列出某个 run 的下载文件：{ name, bytes, mimeType, downloadedAt }[]。',
    inputSchema: { runId: z.string().min(1) },
    annotations: RO,
  }, async ({ runId }) => guard(async () => text(JSON.stringify(await brixJson(`/runs/${enc(runId)}/files`), null, 2))));

  server.registerTool('run_file_get', {
    title: 'Get run file',
    description: `取某个 run 的一个下载文件。图片返回图块；文本返回内容；其余返回 base64。`,
    inputSchema: { runId: z.string().min(1), name: z.string().min(1) },
    annotations: RO,
  }, async ({ runId, name }) => guard(async () => {
    const res = await brixFetch(`/runs/${enc(runId)}/files/${enc(name)}`);
    if (!res.ok) return errText(`brix HTTP ${res.status}`);
    const mime = res.headers.get('Content-Type') ?? 'application/octet-stream';
    const buf = Buffer.from(await res.arrayBuffer());
    if (mime.startsWith('image/')) return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: mime }] };
    if (mime.startsWith('text/') || mime.includes('json')) return text(buf.toString('utf-8'));
    return text(`(${mime}, ${buf.length} bytes, base64)\n${buf.toString('base64').slice(0, CHARACTER_LIMIT)}`);
  }));

  return server;
}
