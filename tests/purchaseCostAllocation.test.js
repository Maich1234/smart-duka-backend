import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateAdditionalCosts, landedUnitCost, round2 } from '../src/services/purchaseCostAllocation.js';

test('none: every line gets zero allocated cost', () => {
  const items = [{ quantity: 2, totalCost: 100 }, { quantity: 3, totalCost: 200 }];
  assert.deepEqual(allocateAdditionalCosts(items, 60, 'none'), [0, 0]);
});

test('zero additional cost total: every line gets zero regardless of method', () => {
  const items = [{ quantity: 2, totalCost: 100 }];
  assert.deepEqual(allocateAdditionalCosts(items, 0, 'quantity'), [0]);
});

test('quantity: spreads proportionally to line quantity', () => {
  const items = [{ quantity: 2, totalCost: 100 }, { quantity: 3, totalCost: 200 }];
  const shares = allocateAdditionalCosts(items, 60, 'quantity');
  assert.deepEqual(shares, [24, 36]);
  assert.equal(shares[0] + shares[1], 60);
});

test('value: spreads proportionally to line totalCost, not quantity', () => {
  const items = [{ quantity: 2, totalCost: 100 }, { quantity: 3, totalCost: 200 }];
  const shares = allocateAdditionalCosts(items, 60, 'value');
  assert.deepEqual(shares, [20, 40]);
  assert.equal(shares[0] + shares[1], 60);
});

test('rounding drift is absorbed by the last non-zero-weight line, sum stays exact', () => {
  const items = [{ quantity: 1, totalCost: 0 }, { quantity: 1, totalCost: 0 }, { quantity: 1, totalCost: 0 }];
  const shares = allocateAdditionalCosts(items, 100, 'quantity');
  assert.equal(shares.reduce((sum, s) => sum + s, 0), 100);
  assert.deepEqual(shares.slice(0, 2), [33.33, 33.33]);
  assert.equal(shares[2], 33.34);
});

test('a line with zero weight gets zero share even under a method that would otherwise divide by it', () => {
  const items = [{ quantity: 0, totalCost: 0 }, { quantity: 5, totalCost: 50 }];
  const shares = allocateAdditionalCosts(items, 20, 'quantity');
  assert.deepEqual(shares, [0, 20]);
});

test('landedUnitCost adds the per-unit share of allocated cost onto the raw unit cost', () => {
  assert.equal(landedUnitCost({ unitCost: 10, quantity: 5 }, 25), 15);
});

test('landedUnitCost falls back to the raw unit cost when quantity is zero', () => {
  assert.equal(landedUnitCost({ unitCost: 10, quantity: 0 }, 25), 10);
});

test('round2 rounds to two decimal places', () => {
  assert.equal(round2(1.005001), 1.01);
  assert.equal(round2(10 / 3), 3.33);
});
