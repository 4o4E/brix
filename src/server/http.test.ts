// HTTP 集成测试：/health、auth 失败路径、跨路由错误形状一致性、兜底 404、JSON 异常。
//
// 这个文件覆盖 server 级别的横切关注点；
// /scripts、/runs/:id/files 各自的 CRUD 在同目录 *.test.ts 拆分。
//
// 重要：env 必须在 import config / 路由模块之前 set 好（getEnv() 单例缓存）。
// 用 setupTestEnv 在 *module top-level* 同步 set。

import { setupTestEnv, startTestServer, authFetch, rawFetch, TEST_TOKEN } from './test-helpers.js';

// 模块顶层：在任何路由 import 之前 set env
setupTestEnv('http');

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from './http.js';

let baseUrl: string;
let stop: () => Promise<void>;

before(async () => {
  const srv = createServer();
  const started = await startTestServer(srv);
  baseUrl = started.baseUrl;
  stop = started.close;
});

after(async () => {
  await stop();
});

// ---------- /health ----------

test('GET /health: public, no token required, 200 {ok:true}', async () => {
  const res = await rawFetch(baseUrl, '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET /health: ignores any token header sent', async () => {
  const res = await rawFetch(baseUrl, '/health', { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(res.status, 200);
});

test('POST /health: method-not-handled falls through to 404', async () => {
  // /health 只在 GET 时短路；其它 method 不被特殊处理 → 进入 auth → 没 token → 403
  const res = await rawFetch(baseUrl, '/health', { method: 'POST' });
  assert.equal(res.status, 403);
});

// ---------- auth 失败：覆盖每个受保护的根路径 ----------

const protectedPaths: Array<[string, string]> = [
  ['GET', '/scripts'],
  ['GET', '/scripts/anything'],
  ['PUT', '/scripts/foo'],
  ['DELETE', '/scripts/foo'],
  ['GET', '/runs/abc/files'],
  ['GET', '/runs/abc/files/x.png'],
  ['DELETE', '/runs/abc/files/x.png'],
  ['GET', '/sessions'],
  ['POST', '/sessions'],
  ['POST', '/sessions/sid/scripts/foo'],
  ['DELETE', '/sessions/sid'],
  ['GET', '/mcp'],
  ['POST', '/mcp'],
  ['DELETE', '/mcp'],
];

for (const [method, path] of protectedPaths) {
  test(`auth: ${method} ${path} → 403 without token`, async () => {
    const res = await rawFetch(baseUrl, path, { method });
    assert.equal(res.status, 403);
    const body = await res.json() as { error: string };
    assert.deepEqual(body, { error: 'forbidden' });
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  });

  test(`auth: ${method} ${path} → 403 with wrong Bearer`, async () => {
    const res = await rawFetch(baseUrl, path, {
      method,
      headers: { Authorization: 'Bearer not-the-token' },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'forbidden' });
  });

  test(`auth: ${method} ${path} → 403 with empty Bearer`, async () => {
    const res = await rawFetch(baseUrl, path, {
      method,
      headers: { Authorization: 'Bearer ' },
    });
    assert.equal(res.status, 403);
  });

  test(`auth: ${method} ${path} → 403 with Basic scheme`, async () => {
    const res = await rawFetch(baseUrl, path, {
      method,
      headers: { Authorization: `Basic ${TEST_TOKEN}` },
    });
    assert.equal(res.status, 403);
  });

  test(`auth: ${method} ${path} → 403 with empty X-Brix-Token`, async () => {
    const res = await rawFetch(baseUrl, path, {
      method,
      headers: { 'X-Brix-Token': '' },
    });
    assert.equal(res.status, 403);
  });
}

test('auth: accepts X-Brix-Token alternative header', async () => {
  const res = await rawFetch(baseUrl, '/scripts', { headers: { 'X-Brix-Token': TEST_TOKEN } });
  // 验证不是 403；可能 200（空列表）也可能 500，但不能是 forbidden
  assert.notEqual(res.status, 403);
});

// ---------- 兜底 404 ----------

test('GET /: unknown root path → 404 not_found', async () => {
  const res = await authFetch(baseUrl, '/');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('GET /nope: unknown path → 404 not_found', async () => {
  const res = await authFetch(baseUrl, '/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('GET /scripts/extra/deep: scripts route does not match → 404', async () => {
  // /scripts/:name 不允许 / 在 name 内（[^/]+），多层路径不命中任何 handler → 404
  const res = await authFetch(baseUrl, '/scripts/a/b/c');
  assert.equal(res.status, 404);
});

// ---------- 错误形状一致性 ----------

test('error shape: 403 body is {error}', async () => {
  const res = await rawFetch(baseUrl, '/scripts');
  assert.equal(res.status, 403);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(typeof body.error, 'string');
  // 不应该有 details 字段
  assert.ok(!('details' in body));
});

test('error shape: 404 body is {error}', async () => {
  const res = await authFetch(baseUrl, '/totally-bogus');
  assert.equal(res.status, 404);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(typeof body.error, 'string');
});

test('error shape: 400 body has {error, details}', async () => {
  // PUT /scripts/foo with non-JSON body → readJson throws → 400 bad_request with details
  const res = await authFetch(baseUrl, '/scripts/foo', {
    method: 'PUT',
    body: 'this is not json at all',
  });
  assert.equal(res.status, 400);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.error, 'bad_request');
  assert.equal(typeof body.details, 'string');
});

// ---------- malformed JSON body ----------

test('PUT /scripts/foo with malformed JSON → 400 bad_request', async () => {
  const res = await authFetch(baseUrl, '/scripts/foo', {
    method: 'PUT',
    body: '{not-json}',
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string; details?: string };
  assert.equal(body.error, 'bad_request');
});

test('PUT /scripts/foo with empty body → 400 (source required)', async () => {
  const res = await authFetch(baseUrl, '/scripts/foo', { method: 'PUT' });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'bad_request');
});

test('PUT /scripts/foo with JSON missing source → 400', async () => {
  const res = await authFetch(baseUrl, '/scripts/foo', {
    method: 'PUT',
    body: JSON.stringify({ notSource: 'x' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'bad_request');
});

// ---------- method-not-allowed ----------

test('PATCH /scripts → 405 method_not_allowed (list route)', async () => {
  const res = await authFetch(baseUrl, '/scripts', { method: 'PATCH' });
  assert.equal(res.status, 405);
  assert.equal(((await res.json()) as { error: string }).error, 'method_not_allowed');
});

test('PATCH /sessions → 405 method_not_allowed', async () => {
  const res = await authFetch(baseUrl, '/sessions', { method: 'PATCH' });
  assert.equal(res.status, 405);
});
