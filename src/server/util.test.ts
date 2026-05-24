import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readJson } from './util.js';

function makeReq(body: Buffer | string): IncomingMessage {
  // readJson 只用了 async iterator 接口；Readable 满足
  const stream = Readable.from([typeof body === 'string' ? Buffer.from(body) : body]);
  return stream as unknown as IncomingMessage;
}

function makeChunkedReq(chunks: Buffer[]): IncomingMessage {
  return Readable.from(chunks) as unknown as IncomingMessage;
}

test('readJson: parses valid JSON object', async () => {
  const r = await readJson<{ a: number; b: string }>(makeReq('{"a":1,"b":"x"}'));
  assert.deepEqual(r, { a: 1, b: 'x' });
});

test('readJson: parses JSON array', async () => {
  assert.deepEqual(await readJson(makeReq('[1,2,3]')), [1, 2, 3]);
});

test('readJson: empty body → null', async () => {
  assert.equal(await readJson(makeReq('')), null);
});

test('readJson: invalid JSON throws', async () => {
  await assert.rejects(() => readJson(makeReq('not json')), /invalid json body/);
  await assert.rejects(() => readJson(makeReq('{')), /invalid json body/);
});

test('readJson: handles multi-chunk body', async () => {
  const r = await readJson<{ msg: string }>(
    makeChunkedReq([Buffer.from('{"msg":"hel'), Buffer.from('lo"}')]),
  );
  assert.deepEqual(r, { msg: 'hello' });
});

test('readJson: body over 4 MB throws', async () => {
  const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61); // 4MB+1 of 'a'
  await assert.rejects(() => readJson(makeReq(big)), /body too large/);
});

test('readJson: body exactly at 4 MB limit accepted (if valid json)', async () => {
  // Build a string ~4MB of valid JSON: {"x":"<lots of a>"}
  const filler = 'a'.repeat(4 * 1024 * 1024 - 16);
  const payload = `{"x":"${filler}"}`;
  assert.ok(Buffer.byteLength(payload) <= 4 * 1024 * 1024);
  const r = await readJson<{ x: string }>(makeReq(payload));
  assert.equal(r!.x.length, filler.length);
});

test('readJson: utf-8 multi-byte chars handled', async () => {
  const r = await readJson<{ msg: string }>(makeReq('{"msg":"日本"}'));
  assert.equal(r!.msg, '日本');
});
