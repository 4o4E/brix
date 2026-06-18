// /sessions/:sid/actions 与 /sessions/:sid/trace 路由契约 + executeAction 参数校验。
//
// 不起 Chrome：create session 需要真浏览器，所以路由层只测无 session 可达的分支
// （404/405）。参数校验（BadActionError）走 executeAction 单测，用 fake session —— 那些
// 错误在触达 page 之前就抛出，无需真页面。

import { setupTestEnv, startTestServer, authFetch } from '../test-helpers.js';

setupTestEnv('actions');

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from '../http.js';
import { executeAction, BadActionError } from './actions.js';
import type { BrixSession } from '../../sessions/registry.js';

let baseUrl: string;
let stop: () => Promise<void>;

before(async () => {
  const started = await startTestServer(createServer());
  baseUrl = started.baseUrl;
  stop = started.close;
});

after(async () => { await stop(); });

// ---------- 路由契约 ----------

test('GET /sessions/x/actions → 405', async () => {
  const res = await authFetch(baseUrl, '/sessions/x/actions');
  assert.equal(res.status, 405);
});

test('POST /sessions/<unknown>/actions → 404 session', async () => {
  const res = await authFetch(baseUrl, '/sessions/nope/actions', {
    method: 'POST',
    body: JSON.stringify({ op: 'url' }),
  });
  assert.equal(res.status, 404);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'not_found');
});

test('GET /sessions/<unknown>/trace → 404 session', async () => {
  const res = await authFetch(baseUrl, '/sessions/nope/trace');
  assert.equal(res.status, 404);
});

test('POST /sessions/x/trace → 405', async () => {
  const res = await authFetch(baseUrl, '/sessions/x/trace', { method: 'POST', body: '{}' });
  assert.equal(res.status, 405);
});

test('actions without auth → 403', async () => {
  const res = await fetch(`${baseUrl}/sessions/x/actions`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 403);
});

// ---------- executeAction 参数校验（fake session，不碰真 page） ----------

function fakeSession(): BrixSession {
  return { sessionId: 'unit', page: {} as never, createdAt: 0, lastActiveAt: 0 };
}

test('executeAction: 缺 op → BadActionError', async () => {
  await assert.rejects(() => executeAction(fakeSession(), {}), (e) => e instanceof BadActionError);
});

test('executeAction: 未知 op → BadActionError', async () => {
  await assert.rejects(() => executeAction(fakeSession(), { op: 'frobnicate' }), (e) => e instanceof BadActionError);
});

test('executeAction: navigate 缺 url → BadActionError', async () => {
  await assert.rejects(() => executeAction(fakeSession(), { op: 'navigate' }), (e) => e instanceof BadActionError);
});

test('executeAction: click 缺 target → BadActionError', async () => {
  await assert.rejects(() => executeAction(fakeSession(), { op: 'click' }), (e) => e instanceof BadActionError);
});
