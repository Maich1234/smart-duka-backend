import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSaleLine, SaleLineError } from '../src/services/pricingEngine.js';

// resolveSaleLine only queries the database for bundle components that are
// not already in productCache — every test pre-seeds the cache, so no DB.

const ctx = (cacheEntries = []) => ({
  shop: 'shop-1',
  session: null,
  productCache: new Map(cacheEntries),
});

const standardProduct = (over = {}) => ({
  _id: 'p1',
  name: 'Sugar 1kg',
  productType: 'standard',
  sellingPrice: 150,
  quantity: 10,
  trackInventory: true,
  promotions: [],
  ...over,
});

test('standard: prices, deducts stock, whole subtotal', async () => {
  const product = standardProduct();
  const line = await resolveSaleLine(product, { quantity: 3 }, ctx());
  assert.equal(line.unitPrice, 150);
  assert.equal(line.subtotal, 450);
  assert.equal(product.quantity, 7);
});

test('standard: rejects fractional quantity', async () => {
  await assert.rejects(
    resolveSaleLine(standardProduct(), { quantity: 1.5 }, ctx()),
    SaleLineError
  );
});

test('standard: rejects insufficient stock without mutating it', async () => {
  const product = standardProduct({ quantity: 2 });
  await assert.rejects(resolveSaleLine(product, { quantity: 5 }, ctx()), SaleLineError);
  assert.equal(product.quantity, 2);
});

test('standard: untracked inventory never blocks or deducts', async () => {
  const product = standardProduct({ trackInventory: false, quantity: 0 });
  const line = await resolveSaleLine(product, { quantity: 4 }, ctx());
  assert.equal(line.subtotal, 600);
  assert.equal(product.quantity, 0);
});

test('promotion: buy 2 get 1 free — pay for 2 of 3', async () => {
  const product = standardProduct({
    promotions: [{ isActive: true, buyQty: 2, freeQty: 1, label: '2+1' }],
  });
  const line = await resolveSaleLine(product, { quantity: 3 }, ctx());
  assert.equal(line.subtotal, 300);
  assert.equal(line.discountAmount, 150);
  assert.equal(line.appliedPromotionLabel, '2+1');
  assert.equal(product.quantity, 7, 'all 3 units leave stock');
});

test('variable: enforces min/max price bounds', async () => {
  const product = standardProduct({ productType: 'variable', minPrice: 100, maxPrice: 200 });
  await assert.rejects(resolveSaleLine(product, { quantity: 1, unitPrice: 50 }, ctx()), SaleLineError);
  await assert.rejects(resolveSaleLine(product, { quantity: 1, unitPrice: 300 }, ctx()), SaleLineError);
  const line = await resolveSaleLine(product, { quantity: 1, unitPrice: 180 }, ctx());
  assert.equal(line.subtotal, 180);
});

test('weighted: fractional quantities are allowed', async () => {
  const product = standardProduct({ productType: 'weighted', unitOfMeasure: 'kg', quantity: 5 });
  const line = await resolveSaleLine(product, { quantity: 0.5 }, ctx());
  assert.equal(line.subtotal, 75);
  assert.equal(line.unitOfMeasure, 'kg');
  assert.equal(product.quantity, 4.5);
});

test('bundle: deducts every component from the cache', async () => {
  const soda = { _id: 'c1', name: 'Soda', trackInventory: true, quantity: 24 };
  const chips = { _id: 'c2', name: 'Chips', trackInventory: true, quantity: 10 };
  const bundle = standardProduct({
    _id: 'b1',
    name: 'Snack Combo',
    productType: 'bundle',
    sellingPrice: 250,
    bundleItems: [
      { product: 'c1', quantity: 2 },
      { product: 'c2', quantity: 1 },
    ],
  });
  const context = ctx([
    ['c1', soda],
    ['c2', chips],
  ]);
  const line = await resolveSaleLine(bundle, { quantity: 3 }, context);
  assert.equal(line.subtotal, 750);
  assert.equal(soda.quantity, 18);
  assert.equal(chips.quantity, 7);
});

test('bundle: insufficient component stock rejects the line', async () => {
  const soda = { _id: 'c1', name: 'Soda', trackInventory: true, quantity: 1 };
  const bundle = standardProduct({
    productType: 'bundle',
    bundleItems: [{ product: 'c1', quantity: 2 }],
  });
  await assert.rejects(
    resolveSaleLine(bundle, { quantity: 1 }, ctx([['c1', soda]])),
    SaleLineError
  );
});

test('configurable: deducts the chosen variant and snapshots its name', async () => {
  const variants = [
    { _id: 'v1', name: '500ml', sellingPrice: 60, quantity: 12 },
    { _id: 'v2', name: '1L', sellingPrice: 100, quantity: 6 },
  ];
  const product = standardProduct({
    productType: 'configurable',
    variants: Object.assign(variants, {
      id(id) { return this.find((v) => v._id === id) ?? null; },
    }),
  });
  const line = await resolveSaleLine(product, { quantity: 2, variantId: 'v2' }, ctx());
  assert.equal(line.unitPrice, 100);
  assert.equal(line.variantName, '1L');
  assert.equal(variants[1].quantity, 4);
});

test('configurable: missing variantId rejects', async () => {
  const product = standardProduct({ productType: 'configurable', variants: [] });
  await assert.rejects(resolveSaleLine(product, { quantity: 1 }, ctx()), SaleLineError);
});
