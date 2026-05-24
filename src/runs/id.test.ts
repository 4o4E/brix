import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { nextId } from './id.js';

const BASE62_RE = /^[0-9A-Za-z]{11}$/;

test('nextId: 11 chars, base62 alphabet', () => {
  for (let i = 0; i < 100; i++) {
    assert.match(nextId(), BASE62_RE);
  }
});

test('nextId: 10000 consecutive calls all unique', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10000; i++) seen.add(nextId());
  assert.equal(seen.size, 10000);
});

test('nextId: strictly increasing as base62 strings', () => {
  // base62 alphabet 0-9A-Za-z is lexicographically ordered, and IDs are
  // fixed-width, so lexicographic compare == numeric compare.
  let last = nextId();
  for (let i = 0; i < 5000; i++) {
    const cur = nextId();
    assert.ok(cur > last, `expected ${cur} > ${last} at i=${i}`);
    last = cur;
  }
});

test('nextId: two calls in same ms still differ via sequence', () => {
  const a = nextId();
  const b = nextId();
  assert.notEqual(a, b);
});
