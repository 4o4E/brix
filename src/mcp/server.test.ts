// MCP server 单测：用 in-memory transport 把真实 Client 连到 buildServer()，并 stub 全局
// fetch 当 fake brix —— 不起 Chrome、不起 brix，纯验证 tool→HTTP 映射与结果格式化。
//
// 覆盖：tools/list、body 构造（browser_* → /actions 的 op+params）、formatAction（文本/快照/
// 截图图块/下载提示）、guard 错误映射、run_file_get 的 image/text/base64 分支、browser_wait /
// browser_read 的 op 派发、clip 截断。

import { setupTestEnv } from '../server/test-helpers.js';

setupTestEnv('mcp');

import { test, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildServer } from './server.js';

// ---- fake brix：记录请求 + 按 path/method 返回预设响应 ----

interface Captured { method: string; path: string; body: unknown }
let captured: Captured[] = [];
let handler: (method: string, path: string, body: unknown) => { status?: number; json?: unknown; bytes?: Buffer; contentType?: string };

const realFetch = globalThis.fetch;

function jsonResponse(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    captured.push({ method, path: url.pathname, body });
    const r = handler(method, url.pathname, body);
    if (r.bytes) return new Response(new Uint8Array(r.bytes), { status: r.status ?? 200, headers: { 'Content-Type': r.contentType ?? 'application/octet-stream' } });
    return jsonResponse(r.status ?? 200, r.json ?? {});
  }) as typeof fetch;
});

after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { captured = []; handler = () => ({ json: {} }); });

/** 起一个连到真实 buildServer() 的 in-memory client。 */
async function connectClient(): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

type ToolContent = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ content: ToolContent; isError?: boolean }> {
  const r = await client.callTool({ name, arguments: args });
  return r as { content: ToolContent; isError?: boolean };
}

// ---- tools/list ----

test('tools/list 暴露全部 26 个 tool', async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 26);
  const names = tools.map((t) => t.name);
  for (const n of ['session_open', 'browser_snapshot', 'browser_click', 'browser_action', 'script_save', 'run_file_get']) {
    assert.ok(names.includes(n), `缺 tool ${n}`);
  }
  await client.close();
});

// ---- body 构造：browser_* → /actions ----

test('browser_click 构造 {op:click,target,...} 打到 /sessions/:id/actions', async () => {
  handler = () => ({ json: { runId: 'r1', op: 'click' } });
  const client = await connectClient();
  await call(client, 'browser_click', { sessionId: 'sX', target: 'e3', returnSnapshot: true });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'POST');
  assert.equal(captured[0].path, '/sessions/sX/actions');
  assert.deepEqual(captured[0].body, { op: 'click', target: 'e3', returnSnapshot: true });
  await client.close();
});

test('browser_read 把 what 映射成 op', async () => {
  handler = () => ({ json: { runId: 'r1', op: 'text', result: 'hi' } });
  const client = await connectClient();
  await call(client, 'browser_read', { sessionId: 's1', what: 'text', selector: '#h' });
  assert.equal(captured[0].body && (captured[0].body as any).op, 'text');
  assert.equal((captured[0].body as any).selector, '#h');
  await client.close();
});

test('browser_wait kind→op 派发（selector/url/load）', async () => {
  handler = () => ({ json: { runId: 'r', op: 'waitForSelector' } });
  const client = await connectClient();
  await call(client, 'browser_wait', { sessionId: 's', kind: 'selector', selector: '#x' });
  await call(client, 'browser_wait', { sessionId: 's', kind: 'url', pattern: '**/done' });
  await call(client, 'browser_wait', { sessionId: 's', kind: 'load', state: 'networkidle' });
  assert.deepEqual(captured.map((c) => (c.body as any).op), ['waitForSelector', 'waitForUrl', 'waitForLoad']);
  await client.close();
});

test('browser_action 逃生口透传 op + params', async () => {
  handler = () => ({ json: { runId: 'r', op: 'dblclick' } });
  const client = await connectClient();
  await call(client, 'browser_action', { sessionId: 's', op: 'dblclick', params: { target: 'e1', foo: 1 }, returnSnapshot: true });
  assert.deepEqual(captured[0].body, { op: 'dblclick', target: 'e1', foo: 1, returnSnapshot: true });
  await client.close();
});

// ---- formatAction：快照 / 截图 / 下载 ----

test('snapshot 结果把快照文本作为第二个 text 块返回', async () => {
  handler = () => ({ json: { runId: 'r', op: 'snapshot', snapshot: { text: 'button "Go" [ref=e1]', refCount: 1 } } });
  const client = await connectClient();
  const res = await call(client, 'browser_snapshot', { sessionId: 's' });
  const texts = res.content.filter((c) => c.type === 'text').map((c) => c.text);
  assert.ok(texts.some((t) => t!.includes('op=snapshot')));
  assert.ok(texts.some((t) => t!.includes('[ref=e1]')));
  await client.close();
});

test('screenshot 把 base64 作为 image 块返回', async () => {
  handler = () => ({ json: { runId: 'r', op: 'screenshot', result: { base64: 'AAAA', mimeType: 'image/png' } } });
  const client = await connectClient();
  const res = await call(client, 'browser_screenshot', { sessionId: 's' });
  const img = res.content.find((c) => c.type === 'image');
  assert.ok(img, '应有 image 块');
  assert.equal(img!.data, 'AAAA');
  assert.equal(img!.mimeType, 'image/png');
  await client.close();
});

test('下载结果带文件名与取文件提示', async () => {
  handler = () => ({ json: { runId: 'run9', op: 'click', downloads: [{ name: 'hello.txt', bytes: 12, mimeType: 'text/plain' }] } });
  const client = await connectClient();
  const res = await call(client, 'browser_click', { sessionId: 's', target: '#dl', expectDownload: true });
  const text = res.content.map((c) => c.text ?? '').join('\n');
  assert.ok(text.includes('hello.txt'));
  assert.ok(text.includes('run9'));
  await client.close();
});

// ---- guard 错误映射 ----

test('brix 非 2xx → isError + 可读错误', async () => {
  handler = () => ({ status: 500, json: { error: 'action_failed', details: 'click timeout' } });
  const client = await connectClient();
  const res = await call(client, 'browser_click', { sessionId: 's', target: 'e1' });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text!.includes('brix HTTP 500'));
  assert.ok(res.content[0].text!.includes('click timeout'));
  await client.close();
});

// ---- run_file_get 三分支 ----

test('run_file_get：图片→image 块', async () => {
  handler = () => ({ bytes: Buffer.from('PNGDATA'), contentType: 'image/png' });
  const client = await connectClient();
  const res = await call(client, 'run_file_get', { runId: 'r', name: 'a.png' });
  const img = res.content.find((c) => c.type === 'image');
  assert.ok(img);
  assert.equal(img!.mimeType, 'image/png');
  assert.equal(Buffer.from(img!.data!, 'base64').toString(), 'PNGDATA');
  await client.close();
});

test('run_file_get：文本→text 内容', async () => {
  handler = () => ({ bytes: Buffer.from('hello world'), contentType: 'text/plain' });
  const client = await connectClient();
  const res = await call(client, 'run_file_get', { runId: 'r', name: 'a.txt' });
  assert.equal(res.content[0].type, 'text');
  assert.equal(res.content[0].text, 'hello world');
  await client.close();
});

test('run_file_get：二进制→base64 文本', async () => {
  handler = () => ({ bytes: Buffer.from([0, 1, 2, 3]), contentType: 'application/octet-stream' });
  const client = await connectClient();
  const res = await call(client, 'run_file_get', { runId: 'r', name: 'a.bin' });
  assert.equal(res.content[0].type, 'text');
  assert.ok(res.content[0].text!.includes('base64'));
  await client.close();
});

// ---- 生命周期 / 脚本透传 ----

test('session_open POST /sessions 并回 sessionId', async () => {
  handler = () => ({ status: 201, json: { sessionId: 'sNEW', url: 'about:blank' } });
  const client = await connectClient();
  const res = await call(client, 'session_open', { url: 'about:blank' });
  assert.equal(captured[0].path, '/sessions');
  assert.deepEqual(captured[0].body, { url: 'about:blank' });
  assert.ok(res.content[0].text!.includes('sNEW'));
  await client.close();
});

test('script_run 打到 /sessions/:id/scripts/:name', async () => {
  handler = () => ({ json: { runId: 'r', output: { ok: true }, downloads: [] } });
  const client = await connectClient();
  await call(client, 'script_run', { sessionId: 's1', name: 'gemini-draw', args: { prompt: 'x' } });
  assert.equal(captured[0].path, '/sessions/s1/scripts/gemini-draw');
  assert.deepEqual(captured[0].body, { args: { prompt: 'x' } });
  await client.close();
});
