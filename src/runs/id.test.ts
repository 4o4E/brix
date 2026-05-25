import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { nextId } from './id.js';

const ID_RE = /^\d{4}-\d{2}-\d{2}-[0-9A-Za-z]{11}$/;

test('nextId: YYYY-MM-DD-<11char base62> shape', () => {
  for (let i = 0; i < 100; i++) {
    assert.match(nextId(), ID_RE);
  }
});

test('nextId: date prefix matches local today', () => {
  const id = nextId();
  const d = new Date();
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.ok(id.startsWith(expected + '-'), `id=${id} expected prefix=${expected}-`);
});

test('nextId: 10000 consecutive calls all unique', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10000; i++) seen.add(nextId());
  assert.equal(seen.size, 10000);
});

test('nextId: strictly increasing as strings within a single date', () => {
  // The date prefix is lexicographically sortable (YYYY-MM-DD with zero-pad)
  // and the base62 suffix is monotonic-in-ms-then-seq, so the whole string is
  // strictly increasing when consecutive IDs share a date.
  let last = nextId();
  for (let i = 0; i < 5000; i++) {
    const cur = nextId();
    if (cur.slice(0, 10) === last.slice(0, 10)) {
      assert.ok(cur > last, `expected ${cur} > ${last} at i=${i}`);
    }
    last = cur;
  }
});

test('nextId: two calls in same ms still differ via sequence', () => {
  const a = nextId();
  const b = nextId();
  assert.notEqual(a, b);
});
