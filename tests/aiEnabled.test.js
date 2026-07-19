import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAiEnabled } from '../src/middlewares/requireAiEnabled.js';

test('hasAiEnabled is true when the shop has opted in', () => {
  assert.ok(hasAiEnabled({ aiEnabled: true }));
});

test('hasAiEnabled is false when the shop has opted out', () => {
  assert.ok(!hasAiEnabled({ aiEnabled: false }));
});

test('hasAiEnabled is false for a shop with no flag set, or no shop at all', () => {
  assert.ok(!hasAiEnabled({}));
  assert.ok(!hasAiEnabled(undefined));
  assert.ok(!hasAiEnabled(null));
});
