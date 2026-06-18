// E2E：交互式单步原语（/sessions/:sid/actions）against 真实 Chrome。
//
// 头号验证：ref 跨 HTTP 调用存活 —— snapshot（调用 1）拿到的 eN，在另一次调用（调用 2）里
// click/fill 仍能解析。旧实现（per-run ctx）会报 "ref 不存在"。
// 另覆盖：fill-by-ref → eval 读回、下载捕获 → /runs/:id/files、trace 端点。

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startBrixServer, type BrixServer } from './helpers/brix-server.js';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server.js';

let brix: BrixServer;
let fixture: FixtureServer;

before(async () => {
  fixture = await startFixtureServer();
  brix = await startBrixServer();
});

after(async () => {
  if (brix) await brix.stop();
  if (fixture) await fixture.close();
});

function authed(): Record<string, string> {
  return { Authorization: `Bearer ${brix.token}`, 'Content-Type': 'application/json' };
}

async function action(sid: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${brix.baseUrl}/sessions/${sid}/actions`, {
    method: 'POST', headers: authed(), body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** 从 snapshot 文本里找含 label 的那行的 [ref=eN]。 */
function refForLabel(snapshot: string, label: string): string {
  const line = snapshot.split('\n').find((l) => l.includes(label) && /\[ref=e\d+\]/.test(l));
  assert.ok(line, `snapshot 里找不到含 "${label}" 且带 ref 的行:\n${snapshot}`);
  return /\[ref=(e\d+)\]/.exec(line!)![1];
}

describe('brix /actions interactive primitives e2e', () => {
  test('ref 跨调用存活 + fill-by-ref + 下载 + trace', { timeout: 240_000 }, async () => {
    const createRes = await fetch(`${brix.baseUrl}/sessions`, {
      method: 'POST', headers: authed(), body: JSON.stringify({ url: `${fixture.baseUrl}/` }),
    });
    assert.equal(createRes.status, 201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    try {
      // 调用 1：snapshot —— 拿到 refs
      const snap = await action(sessionId, { op: 'snapshot' });
      assert.equal(snap.status, 200, `snapshot: ${JSON.stringify(snap.json)}`);
      const snapText: string = snap.json.snapshot.text;
      assert.ok(snap.json.snapshot.refCount > 0, 'snapshot 应产出 refs');
      const btnRef = refForLabel(snapText, 'Click me');
      const inputRef = refForLabel(snapText, 'search');

      // 调用 2（独立 HTTP 请求）：click 上一快照的 ref —— 旧实现会 500 "ref 不存在"
      const click = await action(sessionId, { op: 'click', target: btnRef });
      assert.equal(click.status, 200, `跨调用 click(ref) 应成功，实际: ${JSON.stringify(click.json)}`);

      // 调用 3：fill 上一快照的 input ref
      const fill = await action(sessionId, { op: 'fill', target: inputRef, value: 'brix-rocks' });
      assert.equal(fill.status, 200, `跨调用 fill(ref) 应成功: ${JSON.stringify(fill.json)}`);

      // 调用 4：eval 读回，确认 fill 真落到了那个 input
      const ev = await action(sessionId, { op: 'eval', source: 'document.querySelector("#search").value' });
      assert.equal(ev.status, 200);
      assert.equal(ev.json.result, 'brix-rocks', 'fill-by-ref 应写进 #search');

      // 调用 5：下载捕获 → 落到本 session 的 run
      const dl = await action(sessionId, { op: 'click', target: '#dl', expectDownload: true });
      assert.equal(dl.status, 200, `下载捕获应成功: ${JSON.stringify(dl.json)}`);
      const runId: string = dl.json.runId;
      assert.ok(Array.isArray(dl.json.downloads) && dl.json.downloads.length >= 1, '应有下载文件');

      // /runs/:id/files 能列出
      const filesRes = await fetch(`${brix.baseUrl}/runs/${runId}/files`, { headers: authed() });
      assert.equal(filesRes.status, 200);
      const files = (await filesRes.json()) as Array<{ name: string }>;
      assert.ok(files.length >= 1, 'files 端点应列出下载');

      // 截图返回 base64
      const shot = await action(sessionId, { op: 'screenshot' });
      assert.equal(shot.status, 200);
      assert.ok(typeof shot.json.result?.base64 === 'string' && shot.json.result.base64.length > 100, '截图应返回 base64');

      // trace 端点：记录了上面的成功动作
      const traceRes = await fetch(`${brix.baseUrl}/sessions/${sessionId}/trace`, { headers: authed() });
      assert.equal(traceRes.status, 200);
      const { trace } = (await traceRes.json()) as { trace: Array<{ op: string; ok: boolean }> };
      const ops = trace.map((t) => t.op);
      assert.ok(ops.includes('snapshot') && ops.includes('click') && ops.includes('fill'), `trace 应含已执行 op: ${ops.join(',')}`);
      assert.ok(trace.every((t) => t.ok), 'trace 全部成功');
    } finally {
      await fetch(`${brix.baseUrl}/sessions/${sessionId}`, { method: 'DELETE', headers: authed() }).catch(() => { /* ignore */ });
    }
  });

  test('其余 ops：navigate/type/press/select/hover/scroll/text/attr/count/content/title + returnSnapshot', { timeout: 240_000 }, async () => {
    const createRes = await fetch(`${brix.baseUrl}/sessions`, {
      method: 'POST', headers: authed(), body: JSON.stringify({ url: `${fixture.baseUrl}/` }),
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    try {
      // navigate + returnSnapshot：变更类 op 顺带回快照
      const nav = await action(sessionId, { op: 'navigate', url: `${fixture.baseUrl}/`, returnSnapshot: true });
      assert.equal(nav.status, 200, JSON.stringify(nav.json));
      assert.ok(nav.json.snapshot?.text?.includes('fixture'), 'navigate returnSnapshot 应带快照');

      // 读类
      assert.equal((await action(sessionId, { op: 'text', selector: '#hello' })).json.result, 'brix e2e fixture page');
      assert.equal((await action(sessionId, { op: 'attr', selector: '#dl', name: 'href' })).json.result, '/download/hello.txt');
      assert.equal((await action(sessionId, { op: 'count', selector: 'button' })).json.result, 1);
      assert.equal((await action(sessionId, { op: 'title' })).json.result, 'brix e2e fixture');
      assert.ok((await action(sessionId, { op: 'content' })).json.result.includes('<h1'), 'content 应是 HTML');

      // type → 读回
      assert.equal((await action(sessionId, { op: 'type', target: '#search', value: 'typed' })).status, 200);
      assert.equal((await action(sessionId, { op: 'eval', source: 'document.querySelector("#search").value' })).json.result, 'typed');

      // press（聚焦输入后按键，不强求可见效果，只验证不报错）
      assert.equal((await action(sessionId, { op: 'press', key: 'End' })).status, 200);

      // select → 读回
      assert.equal((await action(sessionId, { op: 'select', target: '#fruit', value: 'banana' })).status, 200);
      assert.equal((await action(sessionId, { op: 'eval', source: 'document.querySelector("#fruit").value' })).json.result, 'banana');

      // hover / scroll：仅验证成功
      assert.equal((await action(sessionId, { op: 'hover', target: '#btn-go' })).status, 200);
      assert.equal((await action(sessionId, { op: 'scroll', direction: 'down', amount: 100 })).status, 200);
    } finally {
      await fetch(`${brix.baseUrl}/sessions/${sessionId}`, { method: 'DELETE', headers: authed() }).catch(() => { /* ignore */ });
    }
  });

  test('未知 op → 400 bad_request', { timeout: 60_000 }, async () => {
    const createRes = await fetch(`${brix.baseUrl}/sessions`, { method: 'POST', headers: authed(), body: '{}' });
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    try {
      const r = await action(sessionId, { op: 'frobnicate' });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, 'bad_request');
    } finally {
      await fetch(`${brix.baseUrl}/sessions/${sessionId}`, { method: 'DELETE', headers: authed() }).catch(() => { /* ignore */ });
    }
  });
});
