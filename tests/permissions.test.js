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

test('purchasing permissions are registered under the Purchasing category', () => {
  const purchasingPerms = ALL_PERMISSIONS.filter((p) => p.category === 'Purchasing').map((p) => p.value);
  assert.deepEqual(purchasingPerms, [
    'view_purchases',
    'create_purchases',
    'edit_purchases',
    'delete_purchases',
    'view_purchase_prices',
    'update_inventory_on_purchase',
    'require_purchase_approval',
  ]);
});

test('edit_purchases and delete_purchases imply view_purchases', () => {
  assert.ok(withImpliedPermissions(['edit_purchases']).includes('view_purchases'));
  assert.ok(withImpliedPermissions(['delete_purchases']).includes('view_purchases'));
});
