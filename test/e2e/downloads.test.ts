// Exercises the saveDownload → /runs/:id/files/:name → DELETE round-trip by
// PUT-ing a tiny ad-hoc script that clicks the fixture download link, then
// driving it via the sessions execute endpoint.

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

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Authorization': `Bearer ${brix.token}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Source for an ad-hoc script we PUT to /scripts/dl-test. Triggers a download
// by clicking the #dl link on the fixture page and saves it via run.saveDownload.
const DL_SCRIPT_SOURCE = `
import type { Page } from 'patchright';
import type { Run } from '../src/runs/run.js';

export const meta = {
  description: 'e2e: trigger a download via the fixture page',
  argsExample: {},
};

export async function runInSession(page: Page, _args: unknown, run: Run): Promise<{ saved: string; bytes: number }> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#dl'),
  ]);
  const saved = await run.saveDownload(download, 'hello.txt');
  return { saved: saved.name, bytes: saved.bytes };
}
`;

describe('brix downloads e2e', () => {
  test('PUT ad-hoc script → run → GET file bytes → DELETE file', { timeout: 240_000 }, async () => {
    // 1. PUT /scripts/dl-test
    const putRes = await fetch(`${brix.baseUrl}/scripts/dl-test`, {
      method: 'PUT',
      headers: authed(),
      body: JSON.stringify({ source: DL_SCRIPT_SOURCE }),
    });
    assert.equal(
      putRes.status, 200,
      `PUT /scripts/dl-test: ${putRes.status} ${await putRes.text().catch(() => '')}`,
    );

    // 2. open a session on the fixture page
    const createRes = await fetch(`${brix.baseUrl}/sessions`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ url: `${fixture.baseUrl}/` }),
    });
    assert.equal(createRes.status, 201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    try {
      // 3. run dl-test
      const runRes = await fetch(`${brix.baseUrl}/sessions/${sessionId}/scripts/dl-test`, {
        method: 'POST',
        headers: authed(),
        body: JSON.stringify({ args: {} }),
      });
      const runText = await runRes.text();
      assert.equal(runRes.status, 200, `run dl-test: ${runRes.status} body=${runText.slice(0, 400)}`);
      const runJson = JSON.parse(runText) as {
        runId: string;
        output: { saved: string; bytes: number };
        downloads: Array<{ name: string; bytes: number }>;
      };
      assert.ok(runJson.runId);
      assert.equal(runJson.output.saved, 'hello.txt');
      assert.ok(runJson.output.bytes > 0);
      assert.ok(runJson.downloads.some((d) => d.name === 'hello.txt'), 'downloads list contains hello.txt');

      // 4. GET /runs/:id/files
      const listRes = await fetch(`${brix.baseUrl}/runs/${runJson.runId}/files`, { headers: authed() });
      assert.equal(listRes.status, 200);
      const list = (await listRes.json()) as Array<{ name: string; bytes: number }>;
      assert.ok(list.some((f) => f.name === 'hello.txt'));

      // 5. GET /runs/:id/files/hello.txt → bytes
      const fileRes = await fetch(`${brix.baseUrl}/runs/${runJson.runId}/files/hello.txt`, { headers: authed() });
      assert.equal(fileRes.status, 200);
      assert.match(fileRes.headers.get('content-disposition') ?? '', /attachment/i);
      const bytes = new Uint8Array(await fileRes.arrayBuffer());
      assert.ok(bytes.byteLength > 0);
      const text = new TextDecoder().decode(bytes);
      assert.match(text, /brix-e2e fixture download body/);

      // 6. DELETE /runs/:id/files/hello.txt → 204
      const delRes = await fetch(`${brix.baseUrl}/runs/${runJson.runId}/files/hello.txt`, {
        method: 'DELETE',
        headers: authed(),
      });
      assert.equal(delRes.status, 204);

      // and gone
      const after404 = await fetch(`${brix.baseUrl}/runs/${runJson.runId}/files/hello.txt`, { headers: authed() });
      assert.equal(after404.status, 404);
    } finally {
      await fetch(`${brix.baseUrl}/sessions/${sessionId}`, { method: 'DELETE', headers: authed() }).catch(() => { /* ignore */ });
      await fetch(`${brix.baseUrl}/scripts/dl-test`, { method: 'DELETE', headers: authed() }).catch(() => { /* ignore */ });
    }
  });
});
