// registry 纯逻辑单测：会话作用域 helper（不起 Chrome）。
//   - getSessionRefContext 返回稳定实例
//   - withSessionLock 串行化并发，且前序失败不阻断后续
//   - appendTrace 封顶丢最旧

import { setupTestEnv } from '../server/test-helpers.js';

setupTestEnv('registry');

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { getSessionRefContext, withSessionLock, appendTrace, type BrixSession } from './registry.js';

function fakeSession(): BrixSession {
  return { sessionId: 's', page: {} as never, createdAt: 0, lastActiveAt: 0 };
}

test('getSessionRefContext: 同一 session 多次调用返回同一实例', () => {
  const s = fakeSession();
  const a = getSessionRefContext(s);
  const b = getSessionRefContext(s);
  assert.equal(a, b);
  assert.equal(a, s.refContext);
});

test('withSessionLock: 并发任务被串行化（按提交顺序完成）', async () => {
  const s = fakeSession();
  const order: number[] = [];
  const mk = (n: number, delay: number) => () => new Promise<void>((resolve) => {
    setTimeout(() => { order.push(n); resolve(); }, delay);
  });
  // 先提交慢的，再提交快的：若真串行，结果仍是 1,2,3。
  const p1 = withSessionLock(s, mk(1, 30));
  const p2 = withSessionLock(s, mk(2, 5));
  const p3 = withSessionLock(s, mk(3, 1));
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('withSessionLock: 前序失败不阻断后续，调用方拿到各自结果/异常', async () => {
  const s = fakeSession();
  await assert.rejects(() => withSessionLock(s, async () => { throw new Error('boom'); }));
  const v = await withSessionLock(s, async () => 42);
  assert.equal(v, 42);
});

test('appendTrace: 封顶 200，丢最旧', () => {
  const s = fakeSession();
  for (let i = 0; i < 250; i++) appendTrace(s, { ts: i, op: 'x', params: {}, ok: true });
  assert.equal(s.trace!.length, 200);
  assert.equal(s.trace![0].ts, 50); // 0..49 被丢
  assert.equal(s.trace![199].ts, 249);
});
