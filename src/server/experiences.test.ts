import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import { createServer } from './http.js';
import { authFetch, setupTestEnv, startTestServer } from './test-helpers.js';

const { dataDir } = setupTestEnv('experiences');
const page = { hostname: 'public.example', path: '/find', task: 'find-source', conditions: { device: 'desktop' } };
const note = {
  scope: page, advice: 'Open the source link.', check: 'Verify the source title.', invalidWhen: 'The source link is absent.',
  evidence: { sessionId: 's1', page, ready: true, expected: 'A source link.', observed: 'The source opened.' },
};

test('experience HTTP is authenticated and shares only verified, redacted, in-scope notes', async (t) => {
  const server = await startTestServer(createServer());
  t.after(async () => { await server.close(); await rm(dirname(dataDir), { recursive: true, force: true }); });
  const post = (path: string, body: unknown) => authFetch(server.baseUrl, path, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await fetch(`${server.baseUrl}/experiences/search`, { method: 'POST' })).status, 403);
  for (const invalid of [
    { ...note, advice: 'Cookie: session=private' },
    { ...note, scope: { ...page, hostname: 'public.example/path' } },
    { ...note, scope: { ...page, path: '/find?id=private' } },
    { ...note, evidence: { ...note.evidence, ready: false } },
    { ...note, evidence: { ...note.evidence, page: { ...page, conditions: {} } } },
  ]) assert.equal((await post('/experiences', invalid)).status, 400);
  const published = await post('/experiences', note);
  assert.equal(published.status, 201);
  const { id } = await published.json();
  const found = await post('/experiences/search', page);
  assert.equal(found.status, 200);
  const { experiences: [summary] } = await found.json();
  assert.equal(summary.id, id);
  assert.equal(summary.advice, note.advice);
  assert.ok(!Object.hasOwn(summary, 'evidence'));
  const report = await post(`/experiences/${id}/feedback`, {
    version: 1, kind: 'contradicted', issue: 'source-link-absent',
    evidence: { ...note.evidence, sessionId: 's2', observed: 'Page ready; no source link.' },
  });
  assert.equal(report.status, 200);
  assert.equal((await report.json()).status, 'review');
  assert.deepEqual(await (await post('/experiences/search', page)).json(), { experiences: [] });
  const history = await (await authFetch(server.baseUrl, `/experiences/${id}`)).json();
  assert.equal(history.versions[0].feedback[0].report.evidence.observed, 'Page ready; no source link.');
});