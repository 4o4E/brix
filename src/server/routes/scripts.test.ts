// /scripts CRUD 集成测试。
//
// PR 1 引入双约定：
//   - 默认 PUT 写 .js（新约定，走 AST 校验，禁 import/require/eval/Function）
//   - language='ts' 走旧路径（ts.transpileModule），仅为内置脚本迁移期保留
// BRIX_SKIP_SCRIPT_TSC=1 仅影响 .ts 路径；.js 的 AST 校验总是跑。

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
      if (e.endsWith('.ts') || e.endsWith('.js')) await rm(join(scriptsDir, e), { force: true });
    }
  } catch { /* ignore */ }
});

// 合法脚本源码（满足 isValidScriptName + 有 runInSession 导出，但我们只测 CRUD 不执行）
// PR 1 起默认走 .js (AST 校验)，所以源码必须是合法 JS（不带 TS 类型注解）
const VALID_SOURCE = `export async function runInSession(brix) { return { ok: true }; }\n`;

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
  // 直接落盘一个 _hidden.js
  await writeFile(join(scriptsDir, '_hidden.js'), VALID_SOURCE);
  // 再放一个正常的
  await writeFile(join(scriptsDir, 'visible-via-fs.js'), VALID_SOURCE);
  try {
    const res = await authFetch(baseUrl, '/scripts');
    const list = await res.json() as Array<{ name: string }>;
    const names = list.map((s) => s.name);
    assert.ok(!names.includes('_hidden'));
    assert.ok(names.includes('visible-via-fs'));
  } finally {
    await rm(join(scriptsDir, '_hidden.js'), { force: true });
    await rm(join(scriptsDir, 'visible-via-fs.js'), { force: true });
  }
});

// ---------- legacy ts.transpileModule syntax check (.ts path) ----------

test('PUT /scripts/<bad-syntax-ts>: language=ts + bad source → 400 bad_script', async () => {
  // 临时关闭 skip flag 走 tsc 校验
  const prev = process.env.BRIX_SKIP_SCRIPT_TSC;
  delete process.env.BRIX_SKIP_SCRIPT_TSC;
  try {
    const badSource = `export async function runInSession(page: any, args: any, run: any { return 1 ; }\n`;
    const res = await authFetch(baseUrl, '/scripts/bad-syntax-ts', {
      method: 'PUT',
      body: JSON.stringify({ source: badSource, language: 'ts' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; details?: string };
    assert.equal(body.error, 'bad_script');
    assert.equal(typeof body.details, 'string');
    assert.ok(body.details!.length > 0);
  } finally {
    if (prev !== undefined) process.env.BRIX_SKIP_SCRIPT_TSC = prev;
    else process.env.BRIX_SKIP_SCRIPT_TSC = '1';
    await rm(join(scriptsDir, 'bad-syntax-ts.ts'), { force: true });
  }
});

// ---------- .js AST validation (new path) ----------

test('PUT /scripts/<bad-syntax-js>: invalid JS → 400 bad_script', async () => {
  const bad = `export async function runInSession(brix { return 1 }\n`;
  const res = await authFetch(baseUrl, '/scripts/bad-syntax-js', {
    method: 'PUT',
    body: JSON.stringify({ source: bad }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string; details?: string };
  assert.equal(body.error, 'bad_script');
  assert.ok(body.details && body.details.length > 0);
});

test('PUT /scripts/<no-export>: missing runInSession → 400 bad_script', async () => {
  const src = `export const foo = 1;\n`;
  const res = await authFetch(baseUrl, '/scripts/no-export', {
    method: 'PUT',
    body: JSON.stringify({ source: src }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string; details?: string };
  assert.equal(body.error, 'bad_script');
  assert.match(body.details ?? '', /runInSession/);
});

test('PUT /scripts/<import-blocked>: import statement → 400 bad_script', async () => {
  const src = `import fs from 'node:fs';\nexport async function runInSession(brix) { return fs; }\n`;
  const res = await authFetch(baseUrl, '/scripts/import-blocked', {
    method: 'PUT',
    body: JSON.stringify({ source: src }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string; details?: string };
  assert.equal(body.error, 'bad_script');
  assert.match(body.details ?? '', /import/);
});

test('PUT /scripts/<dynamic-import-blocked>: import() → 400 bad_script', async () => {
  const src = `export async function runInSession(brix) { return await import('node:fs'); }\n`;
  const res = await authFetch(baseUrl, '/scripts/dyn-import-blocked', {
    method: 'PUT',
    body: JSON.stringify({ source: src }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string; details?: string };
  assert.equal(body.error, 'bad_script');
  assert.match(body.details ?? '', /import/);
});

test('PUT /scripts/<require-blocked>: require() reference → 400 bad_script', async () => {
  const src = `export async function runInSession(brix) { return require('node:fs'); }\n`;
  const res = await authFetch(baseUrl, '/scripts/require-blocked', {
    method: 'PUT',
    body: JSON.stringify({ source: src }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'bad_script');
});

test('PUT /scripts/<eval-blocked>: eval reference → 400 bad_script', async () => {
  const src = `export async function runInSession(brix) { eval('1'); return 1; }\n`;
  const res = await authFetch(baseUrl, '/scripts/eval-blocked', {
    method: 'PUT',
    body: JSON.stringify({ source: src }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'bad_script');
});

test('PUT /scripts/<function-ctor-blocked>: Function reference → 400 bad_script', async () => {
  const src = `export async function runInSession(brix) { return new Function('return 1')(); }\n`;
  const res = await authFetch(baseUrl, '/scripts/function-blocked', {
    method: 'PUT',
    body: JSON.stringify({ source: src }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'bad_script');
});

test('PUT /scripts/<bad-language>: language field validation → 400 bad_request', async () => {
  const res = await authFetch(baseUrl, '/scripts/bad-lang', {
    method: 'PUT',
    body: JSON.stringify({ source: VALID_SOURCE, language: 'python' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'bad_request');
});

test('PUT writes .js by default; written script listed with language=js', async () => {
  const res = await authFetch(baseUrl, '/scripts/lang-default', {
    method: 'PUT',
    body: JSON.stringify({ source: VALID_SOURCE }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { meta: { language: string } };
  assert.equal(body.meta.language, 'js');
});

test('PUT with language=ts writes .ts and reports language=ts', async () => {
  const tsSource = `export async function runInSession(_p: unknown, _a: unknown, _r: unknown) { return { ok: true }; }\n`;
  const res = await authFetch(baseUrl, '/scripts/lang-explicit-ts', {
    method: 'PUT',
    body: JSON.stringify({ source: tsSource, language: 'ts' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { meta: { language: string } };
  assert.equal(body.meta.language, 'ts');
});

// #2 回归：写 .ts 时也清同名 .js（之前不对称，会让 PUT language=ts 看似 200 实则不生效）
test('PUT language=ts 时同名 .js 会被清掉（对称清理）', async () => {
  // 先写 .js
  const r1 = await authFetch(baseUrl, '/scripts/lang-swap', {
    method: 'PUT',
    body: JSON.stringify({ source: VALID_SOURCE }),
  });
  assert.equal(r1.status, 200);
  assert.equal(((await r1.json()) as { meta: { language: string } }).meta.language, 'js');

  // 改写为 .ts —— 应当真正生效（GET 看到 ts），而不是被残留的 .js 盖掉
  const tsSrc = `export async function runInSession(_p: unknown, _a: unknown, _r: unknown) { return { ok: true }; }\n`;
  const r2 = await authFetch(baseUrl, '/scripts/lang-swap', {
    method: 'PUT',
    body: JSON.stringify({ source: tsSrc, language: 'ts' }),
  });
  assert.equal(r2.status, 200);
  assert.equal(((await r2.json()) as { meta: { language: string } }).meta.language, 'ts');

  const r3 = await authFetch(baseUrl, '/scripts/lang-swap');
  assert.equal(r3.status, 200);
  const got = (await r3.json()) as { meta: { language: string }; source: string };
  assert.equal(got.meta.language, 'ts', '改写 ts 后 GET 应返回 ts，否则说明同名 .js 残留把 .ts 盖了');
  assert.equal(got.source, tsSrc);

  // 反向：再写回 .js，同名 .ts 也要被清
  const r4 = await authFetch(baseUrl, '/scripts/lang-swap', {
    method: 'PUT',
    body: JSON.stringify({ source: VALID_SOURCE }),
  });
  assert.equal(r4.status, 200);
  const r5 = await authFetch(baseUrl, '/scripts/lang-swap');
  const got2 = (await r5.json()) as { meta: { language: string } };
  assert.equal(got2.meta.language, 'js');
});

// #4 回归：声明 name 位用 Function/require 不应被误报。
// 注意：AST 校验做不了作用域追踪 —— 一旦把这些标识当 *值* 使用（CallExpression /
// NewExpression / 变量引用），还是会触发 banned-global。这是设计上的保守取舍，
// 因为脚本反正禁了 import/require/eval 的所有能力，作者就不该写出"我要重绑然后调用"
// 的代码。这里仅证明声明位不再误报。
test('PUT /scripts/<decl-name-positions>: 声明名字位的 Function/require 不被误报', async () => {
  const src = `
const Function = 1;
const { Function: localF } = { Function: 2 };
function require() { return 3; }
class MyKlass {
  Function() { return 4; }
}
export async function runInSession(brix) {
  return { ok: true };
}
`;
  const res = await authFetch(baseUrl, '/scripts/decl-name-positions', {
    method: 'PUT',
    body: JSON.stringify({ source: src }),
  });
  assert.equal(res.status, 200, `声明位应通过，实际 ${res.status} ${await res.text().catch(() => '')}`);
});

// #4 回归：但真正引用全局仍然要拦
test('PUT /scripts/<global-still-blocked>: 引用全局 Function 仍要 400', async () => {
  const src = `export async function runInSession(brix) { return Function('return 1')(); }\n`;
  const res = await authFetch(baseUrl, '/scripts/global-still-blocked', {
    method: 'PUT',
    body: JSON.stringify({ source: src }),
  });
  assert.equal(res.status, 400);
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
