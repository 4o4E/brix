import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startTestServer } from '../../src/server/test-helpers.js';
import { startBrixServer } from './helpers/brix-server.js';

const cli = fileURLToPath(new URL('../../skills/brix-browser/scripts/cli.mjs', import.meta.url));
const exec = promisify(execFile);

test('CLI 等待本次结果，保留断线状态，取回完整下载', { timeout: 120_000 }, async (t) => {
  const brix = await startBrixServer();
  t.after(() => brix.stop());
  const site = await startTestServer(createServer((req, res) => {
    if (req.url === '/download') {
      res.writeHead(200, { 'Content-Disposition': 'attachment; filename="result.txt"' });
      return res.end('例：验证文件\r\n');
    }
    // Exercise an independently delayed browser update rather than sleeping in the CLI caller.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<button id="search">Search</button><a href="/download" id="download">Download</a>
      <p id="result" data-query="old">Original</p><p id="clicks">0</p>
      <script>
        document.querySelector('#search').onclick = () => {
          const clicks = document.querySelector('#clicks');
          const n = Number(clicks.textContent) + 1;
          clicks.textContent = n;
          if (n === 1) setTimeout(() => {
            const result = document.querySelector('#result');
            result.dataset.query = 'new';
            result.textContent = 'New results';
          }, 300);
        };
      </script>`);
  }));
  t.after(() => site.close());
  const redirects = await startTestServer(createServer(async (req, res) => {
    const body: Buffer[] = [];
    for await (const part of req) body.push(part);
    const action = JSON.parse(Buffer.concat(body).toString());
    const upstream = await fetch(`${brix.baseUrl}${req.url}`, {
      method: 'POST', headers: { Authorization: `Bearer ${brix.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    const json = await upstream.text();
    if (action.op === 'click') req.socket.destroy();
    else res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(json);
  }));
  t.after(() => redirects.close());

  const call = (args: string[], baseUrl = brix.baseUrl) => exec(process.execPath, [cli, ...args], {
    env: { ...process.env, BRIX_API_URL: baseUrl, BRIX_TOKEN: brix.token },
  });
  const ok = async (...args: string[]) => JSON.parse((await call(args)).stdout);
  const fail = (error: { stderr: string }) => JSON.parse(error.stderr);
  const builtins = await ok('remote', 'list');
  for (const name of ['google-lens', 'gemini-draw', 'chatgpt-draw']) {
    assert.ok(builtins.some((entry: { name: string }) => entry.name === name), `${name} must be provisioned on Brix startup`);
  }
  const { sessionId } = await ok('session', 'open', site.baseUrl);
  const session = ['--session', sessionId];
  const local = join(brix.dataDir, 'search.mjs');
  const input = join(brix.dataDir, 'search.json');
  await writeFile(local, `export async function runInSession(brix) {
    const selector = '#result[data-query=' + JSON.stringify(brix.args.query) + ']';
    await brix.click('#search');
    await brix.waitForSelector(selector, { timeout: brix.args.timeout });
    return { text: await brix.read('text', selector), url: await brix.read('url') };
  }`);
  const args = ['local', 'run', local, ...session, '--args-file', input];
  await writeFile(input, JSON.stringify({ query: 'new', timeout: 5000 }));
  assert.deepEqual((await ok(...args)).output, { text: 'New results', url: `${site.baseUrl}/` });
  assert.equal((await ok('page', 'read', 'text', '#clicks', ...session)).result, '1');
  await writeFile(input, JSON.stringify({ query: 'not-present', timeout: 150 }));
  await assert.rejects(call(args), (error: { stderr: string }) => {
    const data = fail(error);
    assert.equal(data.stage, 'waitForSelector');
    assert.equal(data.dispatch, 'sent_unconfirmed');
    assert.equal(data.sessionId, sessionId);
    assert.ok(data.runId);
    return true;
  });
  assert.equal((await ok('page', 'read', 'text', '#clicks', ...session)).result, '2');
  await assert.rejects(call(args, redirects.baseUrl), (error: { stderr: string }) => {
    const data = fail(error);
    assert.equal(data.stage, 'click');
    assert.equal(data.dispatch, 'unknown');
    return true;
  });
  assert.equal((await ok('page', 'read', 'text', '#clicks', ...session)).result, '3');
  await writeFile(local, `export async function runInSession(brix) {
    await brix.click('#download', { expectDownload: true });
    await brix.waitForSelector('#not-present', { timeout: 150 });
  }`);
  let downloadedRun: string | undefined;
  await assert.rejects(call(args), (error: { stderr: string }) => {
    const data = fail(error);
    assert.equal(data.dispatch, 'sent_unconfirmed');
    assert.deepEqual(data.downloads.map(({ name }: { name: string }) => name), ['result.txt']);
    downloadedRun = data.runId;
    return true;
  });
  assert.ok(downloadedRun);
  const out = join(brix.dataDir, 'fetched.txt');
  await ok('files', 'get', downloadedRun, 'result.txt', out);
  assert.deepEqual(await readFile(out), Buffer.from('例：验证文件\r\n'));
  await ok('session', 'close', sessionId);
});