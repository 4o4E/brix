import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须用 dynamic import：config.ts 模块初次 import 时即缓存 getEnv 结果，
// 所以要先把 BRIX_DATA_DIR 设上，再 import run.js。
let runApi: typeof import('./run.js');
let tmpRoot: string;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'brix-run-test-'));
  process.env.BRIX_DATA_DIR = tmpRoot;
  runApi = await import('./run.js');
});

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

test('createRun: creates dir + downloads dir, dated runId', async () => {
  const run = await runApi.createRun();
  assert.match(run.runId, /^\d{4}-\d{2}-\d{2}-[0-9A-Za-z]{11}$/);
  assert.ok(run.dir.startsWith(tmpRoot));
  assert.ok(run.downloadsDir.startsWith(run.dir));
  const s = await stat(run.downloadsDir);
  assert.ok(s.isDirectory());
});

test('writeArtifact: writes file under dir/, not downloads/', async () => {
  const run = await runApi.createRun();
  const p = await run.writeArtifact('page.html', '<html/>');
  assert.equal(p, join(run.dir, 'page.html'));
  assert.equal((await readFile(p, 'utf-8')), '<html/>');
  // downloads/ stays empty
  assert.deepEqual(await readdir(run.downloadsDir), []);
});

test('writeArtifact: rejects bad name', async () => {
  const run = await runApi.createRun();
  await assert.rejects(() => run.writeArtifact('../escape.txt', 'x'));
  await assert.rejects(() => run.writeArtifact('.hidden', 'x'));
  await assert.rejects(() => run.writeArtifact('a/b', 'x'));
});

test('listDownloads (top-level): empty for new run, populates after writing', async () => {
  const run = await runApi.createRun();
  assert.deepEqual(await runApi.listDownloads(run.runId), []);

  // 直接写到 downloadsDir 模拟 saveDownload 落地
  await writeFile(join(run.downloadsDir, 'image-0.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(run.downloadsDir, 'doc.pdf'), 'fake pdf');

  const list = await run.listDownloads();
  assert.equal(list.length, 2);
  const byName = Object.fromEntries(list.map((f) => [f.name, f]));
  assert.equal(byName['image-0.png'].mimeType, 'image/png');
  assert.equal(byName['image-0.png'].bytes, 4);
  assert.equal(byName['doc.pdf'].mimeType, 'application/pdf');
});

test('listDownloads: unknown runId → NotFoundError', async () => {
  await assert.rejects(() => runApi.listDownloads('NotARealRunId01'), (e: Error) => e.name === 'NotFoundError');
});

test('listDownloads: invalid runId → NotFoundError', async () => {
  await assert.rejects(() => runApi.listDownloads('../etc'), (e: Error) => e.name === 'NotFoundError');
  await assert.rejects(() => runApi.listDownloads(''), (e: Error) => e.name === 'NotFoundError');
});

test('readDownload: returns path/bytes/mime', async () => {
  const run = await runApi.createRun();
  await writeFile(join(run.downloadsDir, 'foo.png'), 'PNGDATA');
  const r = await runApi.readDownload(run.runId, 'foo.png');
  assert.equal(r.bytes, 7);
  assert.equal(r.mimeType, 'image/png');
  assert.equal(r.path, join(run.downloadsDir, 'foo.png'));
});

test('readDownload: nonexistent name → NotFoundError', async () => {
  const run = await runApi.createRun();
  await assert.rejects(() => runApi.readDownload(run.runId, 'nope.png'), (e: Error) => e.name === 'NotFoundError');
});

test('readDownload: bad name (path traversal) → NotFoundError', async () => {
  const run = await runApi.createRun();
  await assert.rejects(() => runApi.readDownload(run.runId, '../../etc/passwd'), (e: Error) => e.name === 'NotFoundError');
  await assert.rejects(() => runApi.readDownload(run.runId, 'a/b'), (e: Error) => e.name === 'NotFoundError');
  await assert.rejects(() => runApi.readDownload(run.runId, '.hidden'), (e: Error) => e.name === 'NotFoundError');
});

test('readDownload: targeting a directory (not file) → NotFoundError', async () => {
  // saveDownload never creates subdirs, but defense-in-depth: if one appears
  // (manual mkdir, race), readDownload must not treat it as a downloadable file.
  const run = await runApi.createRun();
  await mkdir(join(run.downloadsDir, 'subdir'));
  await assert.rejects(() => runApi.readDownload(run.runId, 'subdir'), (e: Error) => e.name === 'NotFoundError');
});

test('deleteDownload: removes file and second read 404s', async () => {
  const run = await runApi.createRun();
  const abs = join(run.downloadsDir, 'kill.txt');
  await writeFile(abs, 'doomed');
  await runApi.deleteDownload(run.runId, 'kill.txt');
  await assert.rejects(() => stat(abs));   // file is gone
  await assert.rejects(() => runApi.readDownload(run.runId, 'kill.txt'), (e: Error) => e.name === 'NotFoundError');
});

test('deleteDownload: idempotent NotFoundError on missing file', async () => {
  const run = await runApi.createRun();
  await assert.rejects(() => runApi.deleteDownload(run.runId, 'never-existed.txt'), (e: Error) => e.name === 'NotFoundError');
});

test('deleteDownload: bad name → NotFoundError, file outside unaffected', async () => {
  const run = await runApi.createRun();
  // 在 tmpRoot 之外建个 sentinel
  const sentinel = join(tmpRoot, 'sentinel.txt');
  await writeFile(sentinel, 'safe');

  await assert.rejects(() => runApi.deleteDownload(run.runId, '../../sentinel.txt'), (e: Error) => e.name === 'NotFoundError');
  await assert.rejects(() => runApi.deleteDownload(run.runId, 'a/b'), (e: Error) => e.name === 'NotFoundError');

  // sentinel must still exist
  const s = await stat(sentinel);
  assert.ok(s.isFile());
});
