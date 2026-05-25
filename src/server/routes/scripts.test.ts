// /scripts CRUD 集成测试。
//
// 用 BRIX_SKIP_SCRIPT_TSC=1 跳过大部分 PUT 的 tsc 校验（spawn npx tsc 太慢）。
// 单独一个 test 关掉这个 env，验证 "真给一个 bad source 拿 400 bad_script"。

import { setupTestEnv, startTestServer, authFetch, TEST_TOKEN } from '../test-helpers.js';

setupTestEnv('scripts');
process.env.BRIX_SKIP_SCRIPT_TSC = '1';

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { rm, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from '../http.js';
import { getEnv } from '../../config.js';

let baseUrl: string;
let stop: () => Promise<void>;
let scriptsDir: string;

before(async () => {
  const srv = createServer();
  const started = await startTestServer(srv);
  baseUrl = started.baseUrl;
  stop = started.close;
  scriptsDir = getEnv().SCRIPTS_DIR;
});

after(async () => {
  await stop();
  // 清理本测试创建的脚本文件，避免污染下次跑或其它测试目录
  try {
    const entries = await readdir(scriptsDir);
    for (const e of entries) {
      if (e.endsWith('.ts')) await rm(join(scriptsDir, e), { force: true });
    }
  } catch { /* ignore */ }
});

// 合法脚本源码（满足 isValidScriptName + 有 runInSession 导出，但我们只测 CRUD 不执行）
const VALID_SOURCE = `export async function runInSession(_page: unknown, _args: unknown, _run: unknown) { return { ok: true }; }\n`;

// ---------- GET /scripts ----------

test('GET /scripts: empty list initially', async () => {
  const res = await authFetch(baseUrl, '/scripts');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.equal((body as unknown[]).length, 0);
});

// ---------- PUT /scripts/:name (create) ----------

test('PUT /scripts/test-create: creates new script, returns 200 with meta', async () => {
  const res = await authFetch(baseUrl, '/scripts/test-create', {
    method: 'PUT',
    body: JSON.stringify({ source: VALID_SOURCE }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { meta: { name: string; bytes: number } };
  assert.equal(body.meta.name, 'test-create');
  assert.equal(body.meta.bytes, Buffer.byteLength(VALID_SOURCE));
});

test('GET /scripts: now lists the created script', async () => {
  const res = await authFetch(baseUrl, '/scripts');
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ name: string }>;
  assert.ok(body.some((s) => s.name === 'test-create'));
});

test('GET /scripts/test-create: returns meta + source', async () => {
  const res = await authFetch(baseUrl, '/scripts/test-create');
  assert.equal(res.status, 200);
  const body = await res.json() as { meta: { name: string }; source: string };
  assert.equal(body.meta.name, 'test-create');
  assert.equal(body.source, VALID_SOURCE);
});

// ---------- PUT (update existing) ----------

test('PUT /scripts/test-create: updates existing, bytes reflect new source', async () => {
  const updated = `${VALID_SOURCE}// updated\n`;
  const res = await authFetch(baseUrl, '/scripts/test-create', {
    method: 'PUT',
    body: JSON.stringify({ source: updated }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { meta: { bytes: number } };
  assert.equal(body.meta.bytes, Buffer.byteLength(updated));

  // verify GET reflects update
  const getRes = await authFetch(baseUrl, '/scripts/test-create');
  const got = await getRes.json() as { source: string };
  assert.equal(got.source, updated);
});

// ---------- name validation ----------

test('PUT /scripts/Invalid-Name: uppercase rejected → 400 bad_script', async () => {
  const res = await authFetch(baseUrl, '/scripts/Invalid-Name', {
    method: 'PUT',
    body: JSON.stringify({ source: VALID_SOURCE }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'bad_script');
});

test('PUT /scripts/-leading-dash: must start with alnum → 400', async () => {
  const res = await authFetch(baseUrl, '/scripts/-leading-dash', {
    method: 'PUT',
    body: JSON.stringify({ source: VALID_SOURCE }),
  });
  assert.equal(res.status, 400);
});

test('PUT /scripts/with_underscore: underscore not in [a-z0-9-] → 400', async () => {
  const res = await authFetch(baseUrl, '/scripts/with_underscore', {
    method: 'PUT',
    body: JSON.stringify({ source: VALID_SOURCE }),
  });
  assert.equal(res.status, 400);
});

test('PUT /scripts/<65-char-name>: too long → 400', async () => {
  const tooLong = 'a' + 'b'.repeat(64); // 65 chars total, max is 64
  const res = await authFetch(baseUrl, `/scripts/${tooLong}`, {
    method: 'PUT',
    body: JSON.stringify({ source: VALID_SOURCE }),
  });
  assert.equal(res.status, 400);
});

test('PUT /scripts/<reserved "serve">: blocked (hidden) → 400', async () => {
  const res = await authFetch(baseUrl, '/scripts/serve', {
    method: 'PUT',
    body: JSON.stringify({ source: VALID_SOURCE }),
  });
  assert.equal(res.status, 400);
});

// ---------- source size ----------

test('PUT /scripts/big: source > 1MB → 400 bad_script', async () => {
  const huge = 'x'.repeat(1_000_001);
  const res = await authFetch(baseUrl, '/scripts/big', {
    method: 'PUT',
    body: JSON.stringify({ source: huge }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'bad_script');
});

test('PUT /scripts/empty: empty source → 400 bad_script', async () => {
  const res = await authFetch(baseUrl, '/scripts/empty', {
    method: 'PUT',
    body: JSON.stringify({ source: '' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'bad_script');
});

// ---------- source typing ----------

test('PUT /scripts/foo: source not a string → 400 bad_request', async () => {
  const res = await authFetch(baseUrl, '/scripts/foo', {
    method: 'PUT',
    body: JSON.stringify({ source: 42 }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'bad_request');
});

// ---------- GET nonexistent ----------

test('GET /scripts/does-not-exist: 404 not_found', async () => {
  const res = await authFetch(baseUrl, '/scripts/does-not-exist');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('GET /scripts/Invalid-Name: invalid name treated as not_found (404)', async () => {
  const res = await authFetch(baseUrl, '/scripts/Invalid-Name');
  assert.equal(res.status, 404);
});

// ---------- DELETE ----------

test('DELETE /scripts/test-create: 204 no content, then GET returns 404', async () => {
  const delRes = await authFetch(baseUrl, '/scripts/test-create', { method: 'DELETE' });
  assert.equal(delRes.status, 204);

  const getRes = await authFetch(baseUrl, '/scripts/test-create');
  assert.equal(getRes.status, 404);
});

test('DELETE /scripts/does-not-exist: 404 not_found', async () => {
  const res = await authFetch(baseUrl, '/scripts/never-existed', { method: 'DELETE' });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('DELETE /scripts/Invalid-Name: invalid name → 404', async () => {
  const res = await authFetch(baseUrl, '/scripts/Invalid-Name', { method: 'DELETE' });
  assert.equal(res.status, 404);
});

// ---------- list reflects fs ----------

test('GET /scripts: hidden scripts (_ prefix) not listed', async () => {
  // 直接落盘一个 _hidden.ts
  await writeFile(join(scriptsDir, '_hidden.ts'), VALID_SOURCE);
  // 再放一个正常的
  await writeFile(join(scriptsDir, 'visible-via-fs.ts'), VALID_SOURCE);
  try {
    const res = await authFetch(baseUrl, '/scripts');
    const list = await res.json() as Array<{ name: string }>;
    const names = list.map((s) => s.name);
    assert.ok(!names.includes('_hidden'));
    assert.ok(names.includes('visible-via-fs'));
  } finally {
    await rm(join(scriptsDir, '_hidden.ts'), { force: true });
    await rm(join(scriptsDir, 'visible-via-fs.ts'), { force: true });
  }
});

// ---------- tsc syntax check (slow path, enabled only here) ----------

test('PUT /scripts/<bad-syntax>: tsc rejects → 400 bad_script (slow path)', async () => {
  // 临时关闭 skip flag
  const prev = process.env.BRIX_SKIP_SCRIPT_TSC;
  delete process.env.BRIX_SKIP_SCRIPT_TSC;
  try {
    // 故意写一段语法错的 TS：缺右括号
    const badSource = `export async function runInSession(page: any, args: any, run: any { return 1 ; }\n`;
    const res = await authFetch(baseUrl, '/scripts/bad-syntax', {
      method: 'PUT',
      body: JSON.stringify({ source: badSource }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; details?: string };
    assert.equal(body.error, 'bad_script');
    // details 应该是 tsc 输出（非空字符串）
    assert.equal(typeof body.details, 'string');
    assert.ok(body.details!.length > 0);
  } finally {
    if (prev !== undefined) process.env.BRIX_SKIP_SCRIPT_TSC = prev;
    else process.env.BRIX_SKIP_SCRIPT_TSC = '1';  // 后续测试再开回 skip
    // 清理：bad-syntax 不应该被写入磁盘（writeScript 在 syntaxCheck 失败时不走到 writeFile）
    await rm(join(scriptsDir, 'bad-syntax.ts'), { force: true });
  }
});

// ---------- method-not-allowed at /scripts/:name ----------

test('PATCH /scripts/foo → 405 method_not_allowed', async () => {
  const res = await authFetch(baseUrl, '/scripts/foo', { method: 'PATCH' });
  assert.equal(res.status, 405);
});

// ---------- 鉴权 sanity（确保我们这文件的 base 行为 OK）----------

test('GET /scripts without token → 403', async () => {
  const res = await fetch(`${baseUrl}/scripts`);
  assert.equal(res.status, 403);
});

// 静默使用 TEST_TOKEN（避免 lint 报未使用）
void TEST_TOKEN;
