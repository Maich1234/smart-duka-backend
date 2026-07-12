import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegex } from '../src/utils/escapeRegex.js';

test('plain text passes through', () => {
  assert.equal(escapeRegex('sukari'), 'sukari');
});

test('escapes every regex metacharacter', () => {
  const escaped = escapeRegex('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o');
  // The escaped string must compile and match the original literal.
  const rx = new RegExp(escaped);
  assert.ok(rx.test('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o'));
});

test('unbalanced paren no longer throws when compiled', () => {
  const userInput = '(';
  assert.throws(() => new RegExp(userInput)); // the original bug
  assert.doesNotThrow(() => new RegExp(escapeRegex(userInput)));
});

test('handles undefined and non-string input', () => {
  assert.equal(escapeRegex(), '');
  assert.equal(escapeRegex(123), '123');
});
