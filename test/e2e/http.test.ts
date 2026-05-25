// brix end-to-end HTTP tests.
//
// Drives a real `tsx scripts/serve.ts` child process which in turn launches
// a real Chrome via CDP, then exercises the documented HTTP surface against
// a local fixture HTML server (no internet).
//
// Run with:  npm run e2e
//
// Requirements:
//   - Google Chrome installed; on Linux set BRIX_CHROME_PATH=/usr/bin/google-chrome
//   - On Linux CI: wrap in `xvfb-run -a ...` because launcher uses --start-maximized

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

describe('brix HTTP e2e', () => {
  test('GET /health is public and returns 200', { timeout: 60_000 }, async () => {
    const r = await fetch(`${brix.baseUrl}/health`);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { ok: boolean };
    assert.equal(j.ok, true);
  });

  test('protected endpoint without token returns 403', { timeout: 60_000 }, async () => {
    const r = await fetch(`${brix.baseUrl}/sessions`);
    assert.equal(r.status, 403);
    const j = (await r.json()) as { error: string };
    assert.equal(j.error, 'forbidden');
  });

  // session lifecycle + scripted snapshot. one combined test so we share the
  // first Chrome warm-up (which is the slow part) and don't pay it 4x.
  test('session lifecycle: create → list → snapshot → files → delete', { timeout: 180_000 }, async () => {
    // 1. POST /sessions with fixture URL → 201 {sessionId}
    const createRes = await fetch(`${brix.baseUrl}/sessions`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ url: `${fixture.baseUrl}/` }),
    });
    // Read body ONCE — assert.equal's message template is evaluated eagerly,
    // so `await createRes.text()` in the message consumes the body before
    // json() can read it. Pull text first, then parse.
    const createText = await createRes.text();
    assert.equal(createRes.status, 201, `create session: ${createRes.status} ${createText}`);
    const created = JSON.parse(createText) as { sessionId: string; url: string };
    assert.ok(created.sessionId, 'sessionId present');
    assert.match(created.url, /127\.0\.0\.1/, 'session opened the fixture URL');
    const sid = created.sessionId;

    try {
      // 2. GET /sessions → list includes sid
      const listRes = await fetch(`${brix.baseUrl}/sessions`, { headers: authed() });
      assert.equal(listRes.status, 200);
      const list = (await listRes.json()) as Array<{ sessionId: string }>;
      assert.ok(Array.isArray(list));
      assert.ok(list.some((s) => s.sessionId === sid), 'new sessionId appears in /sessions');

      // 3. POST /sessions/:sid/scripts/snapshot → 200 {runId, output, downloads}
      const snapRes = await fetch(`${brix.baseUrl}/sessions/${sid}/scripts/snapshot`, {
        method: 'POST',
        headers: authed(),
        body: JSON.stringify({ args: { interactiveOnly: true, maxDepth: 0 } }),
      });
      const snapText = await snapRes.text();
      assert.equal(snapRes.status, 200, `snapshot: ${snapRes.status} body=${snapText.slice(0, 400)}`);
      const snap = JSON.parse(snapText) as {
        runId: string;
        output: { snapshot: string; refCount: number; finalUrl: string };
        downloads: unknown[];
      };
      assert.ok(snap.runId, 'runId present');
      assert.equal(typeof snap.output.snapshot, 'string');
      assert.ok(snap.output.snapshot.length > 0, 'snapshot text non-empty');
      assert.match(snap.output.snapshot, /\[ref=e\d+\]/, 'snapshot contains [ref=eN] markers');
      assert.match(snap.output.finalUrl, /127\.0\.0\.1/, 'finalUrl points at fixture host');
      assert.ok(Array.isArray(snap.downloads));

      // 4. GET /runs/:id/files → 200 array (snapshot has no downloads, so likely [])
      const filesRes = await fetch(`${brix.baseUrl}/runs/${snap.runId}/files`, { headers: authed() });
      assert.equal(filesRes.status, 200);
      const files = (await filesRes.json()) as unknown[];
      assert.ok(Array.isArray(files), 'files response is an array');

      // 5. DELETE /sessions/:sid → 204
      const delRes = await fetch(`${brix.baseUrl}/sessions/${sid}`, {
        method: 'DELETE',
        headers: authed(),
      });
      assert.equal(delRes.status, 204);

      // verify it's gone
      const list2 = await fetch(`${brix.baseUrl}/sessions`, { headers: authed() });
      const list2Json = (await list2.json()) as Array<{ sessionId: string }>;
      assert.ok(!list2Json.some((s) => s.sessionId === sid), 'session removed from list');
    } catch (e) {
      // best-effort cleanup so a failing assertion doesn't leak the session
      await fetch(`${brix.baseUrl}/sessions/${sid}`, { method: 'DELETE', headers: authed() }).catch(() => { /* ignore */ });
      throw e;
    }
  });
});
