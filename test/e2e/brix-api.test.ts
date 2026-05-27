// End-to-end coverage for the new .js / brix-api convention.
//
// downloads.test.ts covers the legacy .ts path; this file proves a .js script
// goes through the BrixScriptApi: it receives `brix` (not `page`), and the
// API surface (snapshot, text, evalInPage, writeArtifact) actually works
// against real Chrome.

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

// .js script using only the brix API. Exercises:
//   - brix.url()              (sync page state)
//   - brix.title()            (async page state)
//   - brix.text(selector)     (DOM read)
//   - brix.snapshot()         (returns { text, refCount })
//   - brix.evalInPage(src)    (string-only injection)
//   - brix.writeArtifact()    (run-dir artifact, not http-exposed)
//   - brix.args               (read echoed-back caller args)
const BRIX_API_SCRIPT = `
export const meta = {
  description: 'e2e: exercises brix-api surface',
  argsExample: { tag: 'hello' },
};

export async function runInSession(brix) {
  const url = brix.url();
  const title = await brix.title();
  const heading = await brix.text('#hello');
  const snap = await brix.snapshot();
  const docTitle = await brix.evalInPage('document.title');
  await brix.writeArtifact('marker.txt', 'brix-api ran ok');
  return {
    url,
    title,
    heading,
    snapHasHello: snap.text.includes('brix e2e fixture page'),
    evalTitle: docTitle,
    argsEcho: brix.args,
    apiKeys: Object.keys(brix).sort(),
  };
}
`;

describe('brix .js / brix-api e2e', () => {
  test('PUT .js script → run through BrixScriptApi → output reflects api calls', { timeout: 240_000 }, async () => {
    // 1. PUT /scripts/brix-api-test  (default language is 'js' → brix-api path)
    const putRes = await fetch(`${brix.baseUrl}/scripts/brix-api-test`, {
      method: 'PUT',
      headers: authed(),
      body: JSON.stringify({ source: BRIX_API_SCRIPT }),
    });
    assert.equal(
      putRes.status, 200,
      `PUT /scripts/brix-api-test: ${putRes.status} ${await putRes.text().catch(() => '')}`,
    );
    const putJson = (await putRes.json()) as { meta: { language: string } };
    assert.equal(putJson.meta.language, 'js', 'default language should be js');

    // 2. GET to confirm meta + source survive a round-trip
    const getRes = await fetch(`${brix.baseUrl}/scripts/brix-api-test`, { headers: authed() });
    assert.equal(getRes.status, 200);
    const getJson = (await getRes.json()) as {
      meta: { language: string; description?: string };
      source: string;
    };
    assert.equal(getJson.meta.language, 'js');
    assert.equal(getJson.meta.description, 'e2e: exercises brix-api surface');
    assert.ok(getJson.source.includes('runInSession(brix)'));

    // 3. open a session on the fixture page
    const createRes = await fetch(`${brix.baseUrl}/sessions`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ url: `${fixture.baseUrl}/` }),
    });
    assert.equal(createRes.status, 201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    try {
      // 4. run brix-api-test with args
      const args = { tag: 'hello', n: 42 };
      const runRes = await fetch(`${brix.baseUrl}/sessions/${sessionId}/scripts/brix-api-test`, {
        method: 'POST',
        headers: authed(),
        body: JSON.stringify({ args }),
      });
      const runText = await runRes.text();
      assert.equal(runRes.status, 200, `run brix-api-test: ${runRes.status} body=${runText.slice(0, 600)}`);
      const runJson = JSON.parse(runText) as {
        runId: string;
        output: {
          url: string;
          title: string;
          heading: string;
          snapHasHello: boolean;
          evalTitle: string;
          argsEcho: unknown;
          apiKeys: string[];
        };
        downloads: Array<{ name: string }>;
      };

      assert.ok(runJson.runId, 'runId returned');
      assert.match(runJson.output.url, /^http:\/\/127\.0\.0\.1:/, 'brix.url() returned fixture url');
      assert.equal(runJson.output.title, 'brix e2e fixture');
      assert.equal(runJson.output.heading, 'brix e2e fixture page');
      assert.equal(runJson.output.snapHasHello, true, 'snapshot text contains heading');
      assert.equal(runJson.output.evalTitle, 'brix e2e fixture', 'evalInPage returned document.title');
      assert.deepEqual(runJson.output.argsEcho, args, 'args echoed back through brix.args');

      // writeArtifact lives in run.dir but is NOT exposed via /runs/:id/files
      // (only saveDownload outputs go there). So downloads list stays empty.
      assert.deepEqual(runJson.downloads, [], 'writeArtifact does not surface as a download');

      // 5. defense check: the script never saw `page` — only `brix`. We can't
      // inspect the call stack from outside, but apiKeys should be exactly
      // the BrixScriptApi surface (no `goto` typo, no `context`, no `_internal`).
      const keys = runJson.output.apiKeys;
      assert.ok(keys.includes('snapshot'), 'has snapshot');
      assert.ok(keys.includes('evalInPage'), 'has evalInPage');
      assert.ok(keys.includes('writeArtifact'), 'has writeArtifact');
      assert.ok(!keys.includes('context'), 'no Page.context() leaked');
      assert.ok(!keys.includes('_internal'), 'no _internal leaked');
    } finally {
      await fetch(`${brix.baseUrl}/sessions/${sessionId}`, { method: 'DELETE', headers: authed() }).catch(() => { /* ignore */ });
      await fetch(`${brix.baseUrl}/scripts/brix-api-test`, { method: 'DELETE', headers: authed() }).catch(() => { /* ignore */ });
    }
  });

  test('PUT .js with `import` → 400 bad_script (AST validation blocks it)', { timeout: 60_000 }, async () => {
    const bad = `
import { readFile } from 'node:fs/promises';
export async function runInSession(brix) {
  return await readFile('/etc/passwd', 'utf-8');
}
`;
    const r = await fetch(`${brix.baseUrl}/scripts/brix-api-bad-import`, {
      method: 'PUT',
      headers: authed(),
      body: JSON.stringify({ source: bad }),
    });
    assert.equal(r.status, 400, `expected 400 bad_script for import, got ${r.status}`);
    const j = (await r.json()) as { error: string };
    assert.equal(j.error, 'bad_script');

    // confirm nothing landed on disk by trying to GET it
    const getR = await fetch(`${brix.baseUrl}/scripts/brix-api-bad-import`, { headers: authed() });
    assert.equal(getR.status, 404);
  });
});
