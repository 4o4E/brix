import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mimeOf, isValidName, isValidRunId, isValidScriptName, sanitizeName } from './mime.js';

test('mimeOf: known extensions map correctly', () => {
  assert.equal(mimeOf('a.png'), 'image/png');
  assert.equal(mimeOf('a.JPG'), 'image/jpeg');
  assert.equal(mimeOf('foo.pdf'), 'application/pdf');
  assert.equal(mimeOf('x.json'), 'application/json');
  assert.equal(mimeOf('x.html'), 'text/html; charset=utf-8');
});

test('mimeOf: unknown / no extension → octet-stream', () => {
  assert.equal(mimeOf('weird.xyz'), 'application/octet-stream');
  assert.equal(mimeOf('no-ext'), 'application/octet-stream');
  assert.equal(mimeOf(''), 'application/octet-stream');
});

test('isValidName: accepts normal filenames', () => {
  assert.ok(isValidName('image-0.png'));
  assert.ok(isValidName('a'));
  assert.ok(isValidName('A_B-c.d.txt'));
  assert.ok(isValidName('x'.repeat(255)));
});

test('isValidName: rejects bad inputs', () => {
  assert.ok(!isValidName(''));
  assert.ok(!isValidName('x'.repeat(256)));      // too long
  assert.ok(!isValidName('.hidden'));            // leading dot
  assert.ok(!isValidName('..'));                 // dotdot
  assert.ok(!isValidName('a/b'));                // slash
  assert.ok(!isValidName('a\\b'));               // backslash
  assert.ok(!isValidName('foo..bar'));           // contains ..
  assert.ok(!isValidName('with space.txt'));    // space
  assert.ok(!isValidName('日本.txt'));           // non-ascii
  assert.ok(!isValidName('null\0byte'));         // null byte
});

test('isValidRunId: same family, 128 max', () => {
  assert.ok(isValidRunId('8KqL2nQrM5x'));
  assert.ok(isValidRunId('A'.repeat(128)));
  assert.ok(!isValidRunId('A'.repeat(129)));
  assert.ok(!isValidRunId('../etc/passwd'));
  assert.ok(!isValidRunId('.hidden'));
  assert.ok(!isValidRunId(''));
});

test('isValidScriptName: lowercase kebab, must start with alnum', () => {
  assert.ok(isValidScriptName('gemini-draw'));
  assert.ok(isValidScriptName('a'));
  assert.ok(isValidScriptName('a1b2'));
  assert.ok(isValidScriptName('x'.repeat(64)));

  assert.ok(!isValidScriptName(''));
  assert.ok(!isValidScriptName('-leading'));
  assert.ok(!isValidScriptName('UPPER'));
  assert.ok(!isValidScriptName('with.dot'));
  assert.ok(!isValidScriptName('with_underscore'));
  assert.ok(!isValidScriptName('x'.repeat(65)));
  assert.ok(!isValidScriptName('../x'));
});

test('sanitizeName: replaces slashes, dotdot, weird chars with _', () => {
  assert.equal(sanitizeName('a/b.png', 'fb.bin'), 'a_b.png');
  assert.equal(sanitizeName('a\\b.png', 'fb.bin'), 'a_b.png');
  // .. → _ (regex replaces the 2-char sequence with a single underscore)
  assert.equal(sanitizeName('foo..bar.txt', 'fb.bin'), 'foo_bar.txt');
  assert.equal(sanitizeName('with space.png', 'fb.bin'), 'with_space.png');
  // each non-[A-Za-z0-9._-] char → _ (char-by-char); 日, 本 are single BMP chars
  assert.equal(sanitizeName('日本.png', 'fb.bin'), '__.png');
});

test('sanitizeName: leading-dot collapsed to _', () => {
  assert.equal(sanitizeName('.hidden', 'fb.bin'), '_hidden');
  // ...secret: first `..` matched by /\.\./g → `_.secret`; leading is now `_`, not `.`,
  // so /^\.+/ doesn't apply. Final: `_.secret`
  assert.equal(sanitizeName('...secret', 'fb.bin'), '_.secret');
});

test('sanitizeName: truncates to 255', () => {
  const out = sanitizeName('a'.repeat(500), 'fb.bin');
  assert.equal(out.length, 255);
});

test('sanitizeName: falls back when result is empty / all bad', () => {
  assert.equal(sanitizeName('', 'fb.bin'), 'fb.bin');
});
