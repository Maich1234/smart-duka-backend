import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PERMISSIONS, PERMISSION_DEPENDENCIES } from '../src/constants/permissions.js';

test('defines create_quotation and convert_quotation_to_sale with no implied dependencies', () => {
  const values = ALL_PERMISSIONS.map((p) => p.value);
  assert.ok(values.includes('create_quotation'));
  assert.ok(values.includes('convert_quotation_to_sale'));
  assert.equal(PERMISSION_DEPENDENCIES.create_quotation, undefined);
  assert.equal(PERMISSION_DEPENDENCIES.convert_quotation_to_sale, undefined);
});
