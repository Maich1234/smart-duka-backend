import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PERMISSIONS, withImpliedPermissions } from '../src/constants/permissions.js';

test('refund permissions are registered', () => {
  const values = ALL_PERMISSIONS.map((p) => p.value);
  assert.ok(values.includes('refund_own_sales'));
  assert.ok(values.includes('refund_all_sales'));
});

test('refund_all_sales implies view_all_sales', () => {
  const expanded = withImpliedPermissions(['record_sale', 'refund_all_sales']);
  assert.ok(expanded.includes('view_all_sales'));
  assert.ok(expanded.includes('refund_all_sales'));
  assert.ok(expanded.includes('record_sale'));
});

test('refund_own_sales does NOT imply view_all_sales', () => {
  const expanded = withImpliedPermissions(['refund_own_sales']);
  assert.ok(!expanded.includes('view_all_sales'));
});

test('no duplicates when the implied permission is already present', () => {
  const expanded = withImpliedPermissions(['view_all_sales', 'refund_all_sales']);
  assert.equal(expanded.filter((p) => p === 'view_all_sales').length, 1);
});

test('handles empty and undefined input', () => {
  assert.deepEqual(withImpliedPermissions([]), []);
  assert.deepEqual(withImpliedPermissions(), []);
});
