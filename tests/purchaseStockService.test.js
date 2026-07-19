import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWeightedAverageCost,
  resolvePurchaseTarget,
  PurchaseLineError,
} from '../src/services/purchaseStockService.js';

test('weighted average: blends prior stock cost with the new receipt', () => {
  // 10 units @ 100 already in stock, receiving 10 more @ 120
  assert.equal(computeWeightedAverageCost(10, 100, 10, 120), 110);
});

test('weighted average: first-ever receipt into an empty product takes the new cost outright', () => {
  assert.equal(computeWeightedAverageCost(0, 0, 5, 50), 50);
});

test('weighted average: heavier prior stock pulls the average toward the old cost', () => {
  // 90 units @ 100, receiving 10 @ 200 — new cost should be close to 100, not 150
  assert.equal(computeWeightedAverageCost(90, 100, 10, 200), 110);
});

const standardProduct = (over = {}) => ({
  _id: 'p1',
  name: 'Sugar 1kg',
  productType: 'standard',
  trackInventory: true,
  quantity: 10,
  costPrice: 100,
  ...over,
});

test('resolvePurchaseTarget: standard product resolves to itself', () => {
  const product = standardProduct();
  assert.equal(resolvePurchaseTarget(product, {}), product);
});

test('resolvePurchaseTarget: rejects bundle and service products', () => {
  assert.throws(() => resolvePurchaseTarget(standardProduct({ productType: 'bundle' }), {}), PurchaseLineError);
  assert.throws(() => resolvePurchaseTarget(standardProduct({ productType: 'service' }), {}), PurchaseLineError);
});

test('resolvePurchaseTarget: rejects products that do not track inventory', () => {
  assert.throws(() => resolvePurchaseTarget(standardProduct({ trackInventory: false }), {}), PurchaseLineError);
});

test('resolvePurchaseTarget: configurable resolves the chosen variant', () => {
  const variants = [
    { _id: 'v1', name: '500ml', quantity: 12, costPrice: 40 },
    { _id: 'v2', name: '1L', quantity: 6, costPrice: 70 },
  ];
  const product = standardProduct({
    productType: 'configurable',
    variants: Object.assign(variants, {
      id(id) { return this.find((v) => v._id === id) ?? null; },
    }),
  });
  const target = resolvePurchaseTarget(product, { variantId: 'v2' });
  assert.equal(target.name, '1L');
});

test('resolvePurchaseTarget: configurable without a variantId rejects', () => {
  const product = standardProduct({ productType: 'configurable', variants: Object.assign([], { id: () => null }) });
  assert.throws(() => resolvePurchaseTarget(product, {}), PurchaseLineError);
});

test('resolvePurchaseTarget: configurable with an unknown variantId rejects', () => {
  const product = standardProduct({ productType: 'configurable', variants: Object.assign([], { id: () => null }) });
  assert.throws(() => resolvePurchaseTarget(product, { variantId: 'missing' }), PurchaseLineError);
});
