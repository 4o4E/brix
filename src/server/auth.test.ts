import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Socket } from 'node:net';
import { IncomingMessage } from 'node:http';
import { checkAuth } from './auth.js';

function makeReq(headers: Record<string, string>): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.url = '/scripts';
  for (const [k, v] of Object.entries(headers)) {
    req.headers[k.toLowerCase()] = v;
  }
  return req;
}

const TOKEN = 'supersecret-token-123';

test('checkAuth: accepts Authorization: Bearer <token>', () => {
  assert.equal(checkAuth(makeReq({ authorization: `Bearer ${TOKEN}` }), TOKEN), true);
});

test('checkAuth: accepts X-Brix-Token: <token>', () => {
  assert.equal(checkAuth(makeReq({ 'x-brix-token': TOKEN }), TOKEN), true);
});

test('checkAuth: X-Brix-Token takes precedence when both present', () => {
  assert.equal(
    checkAuth(makeReq({ 'x-brix-token': TOKEN, authorization: 'Bearer wrong' }), TOKEN),
    true,
  );
});

test('checkAuth: rejects missing token', () => {
  assert.equal(checkAuth(makeReq({}), TOKEN), false);
});

test('checkAuth: rejects wrong token (same length)', () => {
  const wrong = 'x'.repeat(TOKEN.length);
  assert.equal(checkAuth(makeReq({ authorization: `Bearer ${wrong}` }), TOKEN), false);
});

test('checkAuth: rejects wrong token (different length)', () => {
  assert.equal(checkAuth(makeReq({ authorization: 'Bearer short' }), TOKEN), false);
  assert.equal(checkAuth(makeReq({ authorization: `Bearer ${TOKEN}extra` }), TOKEN), false);
});

test('checkAuth: rejects empty Bearer value', () => {
  assert.equal(checkAuth(makeReq({ authorization: 'Bearer ' }), TOKEN), false);
});

test('checkAuth: rejects malformed Authorization header', () => {
  assert.equal(checkAuth(makeReq({ authorization: TOKEN }), TOKEN), false);          // no Bearer prefix
  assert.equal(checkAuth(makeReq({ authorization: `Basic ${TOKEN}` }), TOKEN), false); // wrong scheme
});

test('checkAuth: rejects empty X-Brix-Token', () => {
  assert.equal(checkAuth(makeReq({ 'x-brix-token': '' }), TOKEN), false);
});
