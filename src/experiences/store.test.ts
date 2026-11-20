import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ExperienceStore, feedbackSchema, publishSchema, querySchema } from './store.js';

const day = 86_400_000;
const start = Date.parse('2026-01-01T00:00:00Z');
const page = { hostname: 'catalog.example', path: '/search', task: 'find-source', conditions: { language: 'en', auth: 'signed-out' } };
const evidence = { sessionId: 'first', page, ready: true, expected: 'The result has the source link.', observed: 'The source link leads to the original.' };
const note = { scope: { ...page, mode: 'prefix' }, evidence, advice: 'Open the source link.', check: 'Check the destination.', invalidWhen: 'The loaded cards have no source link.' };

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'brix-experiences-test-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, 'experiences.json');
  let now = start;
  return { file, store: new ExperienceStore(file, () => now), advance: (days: number) => { now += days * day; } };
}

test('scope matches exact host, task, path segments, and confirmed conditions; concurrent revisions preserve history', async (t) => {
  const { store, file } = await fixture(t);
  const { id } = await store.publish(publishSchema.parse(note));
  const lookup = (overrides: Partial<typeof page>) => store.search(querySchema.parse({ ...page, ...overrides }));
  assert.equal((await lookup({ path: '/search/detail' }))[0]?.id, id);
  for (const mismatch of [{ path: '/search-old' }, { hostname: 'other.catalog.example' }, { task: 'other' }, { conditions: { language: 'en' } }, { conditions: { ...page.conditions, auth: 'signed-in' } }]) {
    assert.deepEqual(await store.search(querySchema.parse({ ...page, ...mismatch })), []);
  }
  const revise = (advice: string) => store.publish(publishSchema.parse({ ...note, id, ifVersion: 1, scope: { ...page, mode: 'exact' }, advice }));
  const [winner, loser] = await Promise.allSettled([revise('Revised link A.'), revise('Revised link B.')]);
  assert.equal(winner.status, 'fulfilled');
  assert.equal(loser.status, 'rejected');
  if (loser.status === 'rejected') assert.equal(loser.reason.code, 'version_conflict');
  await store.report(id, feedbackSchema.parse({ version: 1, kind: 'contradicted', issue: 'source-link-absent', evidence: { ...evidence, sessionId: 'older', observed: 'No source link.' } }));
  const restored = new ExperienceStore(file, () => start);
  const { versions } = await restored.show(id);
  assert.deepEqual(versions.map(({ status, feedback }) => [status, feedback.length]), [['superseded', 1], ['active', 0]]);
  assert.equal((await restored.search(querySchema.parse(page)))[0]?.advice, 'Revised link A.');
  assert.deepEqual(await restored.search(querySchema.parse({ ...page, path: '/search/detail' })), []);
  assert.deepEqual(await restored.search(querySchema.parse({ ...page, path: '/search/' })), []);
});

test('transient failures do not renew; same session does not count twice; a confirmed resolution recovers the note', async (t) => {
  const { store, advance } = await fixture(t);
  const { id, version } = await store.publish(publishSchema.parse(note));
  const report = (rest: Record<string, unknown>) => store.report(id, feedbackSchema.parse({ version, ...rest }));
  advance(29);
  const { ready, ...unready } = evidence;
  const temp = await report({ kind: 'temporary_failure', evidence: { ...unready, sessionId: 'blocked', page: { ...page, conditions: {} }, observed: 'Page not ready.' } });
  assert.equal(temp.status, 'active');
  advance(1);
  assert.deepEqual(await store.search(querySchema.parse(page)), []);
  assert.equal((await report({ kind: 'verified', evidence: { ...evidence, sessionId: 'later' } })).status, 'active');

  const issue = 'source-link-absent';
  const failed = { ...evidence, observed: 'The loaded cards have no source link.' };
  const contradict = (sessionId: string, path = page.path) => report({ kind: 'contradicted', issue, evidence: { ...failed, sessionId, page: { ...page, path } } });
  assert.equal((await contradict('one')).status, 'review');
  assert.deepEqual(await store.search(querySchema.parse(page)), []);
  assert.equal((await contradict('one')).status, 'review');
  assert.equal((await contradict('other-page', '/search/detail')).status, 'review');
  assert.equal((await contradict('two')).status, 'stale');
  assert.equal((await report({ kind: 'verified', evidence: { ...evidence, sessionId: 'opposite' } })).status, 'review');
  const resolve = (sessionId: string, path = page.path) => report({ kind: 'resolved', issue, resolution: 'The source link has returned on this page.', evidence: { ...evidence, sessionId, page: { ...page, path } } });
  await assert.rejects(resolve('one'), { message: 'resolution_needs_matching_new_observation' });
  assert.equal((await resolve('fix-one')).status, 'review');
  assert.equal((await resolve('fix-two', '/search/detail')).status, 'active');
  assert.equal((await store.search(querySchema.parse(page)))[0]?.id, id);
  assert.equal((await store.show(id)).versions[0].feedback.length, 8);
});