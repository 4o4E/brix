// /runs/:id/files CRUD 集成测试。
//
// 不调 createRun() —— 直接在 DATA_DIR/runs/<id>/downloads/ 下手工 mkdir + 写文件，
// 然后通过 HTTP 验证 list/get/delete 行为。

import { setupTestEnv, startTestServer, authFetch } from '../test-helpers.js';

setupTestEnv('files');

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from '../http.js';
import { getEnv } from '../../config.js';

let baseUrl: string;
let stop: () => Promise<void>;
let runsRoot: string;

// 已知 runId（YYYY-MM-DD-<11 字符 base62>，符合 isValidRunId）
const RUN_ID = '2026-05-25-TestRunId00';
const EMPTY_RUN_ID = '2026-05-25-EmptyRun001';

before(async () => {
  const srv = createServer();
  const started = await startTestServer(srv);
  baseUrl = started.baseUrl;
  stop = started.close;
  runsRoot = join(getEnv().DATA_DIR, 'runs');

  // 准备一个 run，里面 3 个文件
  const downloads = join(runsRoot, RUN_ID, 'downloads');
  await mkdir(downloads, { recursive: true });
  await writeFile(join(downloads, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(join(downloads, 'doc.pdf'), Buffer.from('%PDF-1.4 fake'));
  await writeFile(join(downloads, 'note.txt'), 'hello world');

  // 一个空 run（downloads/ 存在但没文件）
  await mkdir(join(runsRoot, EMPTY_RUN_ID, 'downloads'), { recursive: true });
});

after(async () => {
  await stop();
  // 清理两个 run 目录（不动其它东西，保持兼容 run.test.ts 用同一个 cached DATA_DIR）
  await rm(join(runsRoot, RUN_ID), { recursive: true, force: true });
  await rm(join(runsRoot, EMPTY_RUN_ID), { recursive: true, force: true });
});

// ---------- GET list ----------

test('GET /runs/:id/files: lists 3 files', async () => {
  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files`);
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ name: string; bytes: number; mimeType: string }>;
  assert.equal(body.length, 3);
  const byName = Object.fromEntries(body.map((f) => [f.name, f]));
  assert.equal(byName['photo.png'].mimeType, 'image/png');
  assert.equal(byName['doc.pdf'].mimeType, 'application/pdf');
  assert.equal(byName['note.txt'].mimeType, 'text/plain; charset=utf-8');
  assert.equal(byName['note.txt'].bytes, 11);
});

test('GET /runs/:id/files: empty downloads dir → 200 empty array', async () => {
  const res = await authFetch(baseUrl, `/runs/${EMPTY_RUN_ID}/files`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('GET /runs/:id/files: unknown runId → 404', async () => {
  const res = await authFetch(baseUrl, '/runs/NoSuchRunXX/files');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('GET /runs/:id/files: invalid runId (with ..) → 404 not_found', async () => {
  // path traversal via the runId segment; the URL itself uses no real `..`
  // because that gets normalized in URL parsing. Test with a clearly-invalid form.
  // Use a runId that fails RE: contains '!'
  const res = await authFetch(baseUrl, '/runs/bad!id/files');
  assert.equal(res.status, 404);
});

// ---------- GET single file ----------

test('GET /runs/:id/files/:name: serves file with correct Content-Type', async () => {
  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/photo.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-length'), '8');
  assert.ok(res.headers.get('content-disposition')?.includes('photo.png'));
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 8);
  // PNG magic bytes
  assert.equal(buf[0], 0x89);
});

test('GET /runs/:id/files/:name: text file content correct', async () => {
  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/note.txt`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello world');
});

test('GET /runs/:id/files/missing.png: 404 not_found', async () => {
  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/missing.png`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('GET /runs/:id/files/.hidden: dotfile rejected → 404', async () => {
  // create a real .hidden file to ensure rejection is by name validation, not absence
  const downloads = join(runsRoot, RUN_ID, 'downloads');
  await writeFile(join(downloads, '.hidden'), 'secret');
  try {
    const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/.hidden`);
    assert.equal(res.status, 404);
  } finally {
    await rm(join(downloads, '.hidden'), { force: true });
  }
});

test('GET /runs/:id/files/name-with-dotdot: rejected via isValidName → 404', async () => {
  // URL-encoded .. is preserved in path segment; route regex [^/]+ allows it,
  // but isValidName rejects names containing '..'
  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/a..b`);
  assert.equal(res.status, 404);
});

test('GET path traversal via %2F (encoded slash): treated as part of name → 404', async () => {
  // %2F decodes to '/'; that breaks isValidName ([A-Za-z0-9._-] only) → 404
  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(res.status, 404);
});

test('GET with backslash in name: → 404', async () => {
  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/a%5Cb`);
  assert.equal(res.status, 404);
});

// ---------- DELETE ----------

test('DELETE /runs/:id/files/:name: 204 + file gone', async () => {
  const downloads = join(runsRoot, RUN_ID, 'downloads');
  const target = join(downloads, 'temp-to-delete.txt');
  await writeFile(target, 'bye');
  // sanity
  await stat(target);

  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/temp-to-delete.txt`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  // file gone
  await assert.rejects(() => stat(target));
});

test('DELETE missing file: 404 not_found', async () => {
  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/never-existed.bin`, { method: 'DELETE' });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('DELETE with .. in name: 404 (no escape, no real file affected)', async () => {
  // sentinel above the run dir
  const sentinel = join(runsRoot, 'sentinel.txt');
  await writeFile(sentinel, 'safe');
  try {
    const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/..%2F..%2Fsentinel.txt`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    // sentinel must still exist
    await stat(sentinel);
  } finally {
    await rm(sentinel, { force: true });
  }
});

// ---------- method-not-allowed ----------

test('POST /runs/:id/files → 405 method_not_allowed', async () => {
  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files`, { method: 'POST' });
  assert.equal(res.status, 405);
});

test('POST /runs/:id/files/:name → 405 method_not_allowed', async () => {
  const res = await authFetch(baseUrl, `/runs/${RUN_ID}/files/note.txt`, { method: 'POST' });
  assert.equal(res.status, 405);
});

// ---------- auth sanity ----------

test('GET /runs/:id/files without token → 403', async () => {
  const res = await fetch(`${baseUrl}/runs/${RUN_ID}/files`);
  assert.equal(res.status, 403);
});
