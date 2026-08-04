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
  costPrice: 110,
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

// --- Cost of goods snapshot -------------------------------------------------
// unitCost is captured at sale time because purchasing rewrites Product.costPrice
// as a weighted average on every landed-cost allocation, so reading cost back
// from the product later makes a past period's profit drift.

test('cost: standard line snapshots the product cost price', async () => {
  const line = await resolveSaleLine(standardProduct(), { quantity: 3 }, ctx());
  assert.equal(line.unitCost, 110);
});

test('cost: a product with no cost price yields null, not zero', async () => {
  const line = await resolveSaleLine(standardProduct({ costPrice: undefined }), { quantity: 1 }, ctx());
  assert.equal(line.unitCost, null, 'null means unknown — books report it as estimated');
});

test('cost: a genuine zero cost is preserved as 0, not collapsed to null', async () => {
  const service = standardProduct({ productType: 'service', costPrice: 0 });
  const line = await resolveSaleLine(service, { quantity: 1 }, ctx());
  assert.equal(line.unitCost, 0, 'a service really can cost nothing; that is not the same as unknown');
});

test('cost: promotional free goods still carry cost on the full quantity', async () => {
  const product = standardProduct({
    promotions: [{ isActive: true, buyQty: 2, freeQty: 1, label: '2+1' }],
  });
  const line = await resolveSaleLine(product, { quantity: 3 }, ctx());
  assert.equal(line.subtotal, 300, 'customer pays for 2');
  assert.equal(line.quantity, 3, 'but 3 units left the shelf...');
  assert.equal(line.unitCost, 110, '...and the controller costs all 3');
});

test('cost: weighted lines cost per unit of measure', async () => {
  const product = standardProduct({ productType: 'weighted', unitOfMeasure: 'kg', quantity: 5 });
  const line = await resolveSaleLine(product, { quantity: 0.5 }, ctx());
  assert.equal(line.unitCost, 110, '0.5 kg × 110/kg = 55, multiplied out by the caller');
});

test('cost: bundle cost is the sum of its components, not its own cost price', async () => {
  const soda = { _id: 'c1', name: 'Soda', costPrice: 30, trackInventory: true, quantity: 24 };
  const chips = { _id: 'c2', name: 'Chips', costPrice: 45, trackInventory: true, quantity: 10 };
  const bundle = standardProduct({
    _id: 'b1',
    productType: 'bundle',
    sellingPrice: 250,
    costPrice: 999, // deliberately wrong — must be ignored
    bundleItems: [
      { product: 'c1', quantity: 2 },
      { product: 'c2', quantity: 1 },
    ],
  });
  const line = await resolveSaleLine(bundle, { quantity: 3 }, ctx([['c1', soda], ['c2', chips]]));
  assert.equal(line.unitCost, 105, '2 × 30 + 1 × 45');
});

test('cost: bundle with one un-costed component is unknown, not partially summed', async () => {
  const soda = { _id: 'c1', name: 'Soda', costPrice: 30, trackInventory: true, quantity: 24 };
  const chips = { _id: 'c2', name: 'Chips', trackInventory: true, quantity: 10 };
  const bundle = standardProduct({
    productType: 'bundle',
    bundleItems: [
      { product: 'c1', quantity: 2 },
      { product: 'c2', quantity: 1 },
    ],
  });
  const line = await resolveSaleLine(bundle, { quantity: 1 }, ctx([['c1', soda], ['c2', chips]]));
  assert.equal(line.unitCost, null, 'a partial sum would understate COGS and overstate profit');
});

test('cost: configurable line takes the variant cost, not the parent product cost', async () => {
  const variants = [
    { _id: 'v1', name: '500ml', sellingPrice: 60, costPrice: 40, quantity: 12 },
    { _id: 'v2', name: '1L', sellingPrice: 100, costPrice: 72, quantity: 6 },
  ];
  const product = standardProduct({
    productType: 'configurable',
    costPrice: 999, // deliberately wrong — must be ignored
    variants: Object.assign(variants, {
      id(id) { return this.find((v) => v._id === id) ?? null; },
    }),
  });
  const line = await resolveSaleLine(product, { quantity: 2, variantId: 'v2' }, ctx());
  assert.equal(line.unitCost, 72);
});

test('cost: configurable variant without a cost price yields null', async () => {
  const variants = [{ _id: 'v1', name: '500ml', sellingPrice: 60, quantity: 12 }];
  const product = standardProduct({
    productType: 'configurable',
    variants: Object.assign(variants, {
      id(id) { return this.find((v) => v._id === id) ?? null; },
    }),
  });
  const line = await resolveSaleLine(product, { quantity: 1, variantId: 'v1' }, ctx());
  assert.equal(line.unitCost, null);
});

// --- Employee commission ----------------------------------------------------
// Commission is a split of whatever the line earns above the shop's per-unit
// floor. It used to be computed only for `configurable` variants, which meant
// an ordinary shop selling standard products could switch commission on and
// never generate a shilling of it.

const withCommission = (over = {}) => ({ enabled: true, basePrice: 400, employeeSharePercent: 90, ...over });

const configurable = (variants, over = {}) => standardProduct({
  productType: 'configurable',
  variants: Object.assign(variants, {
    id(id) { return this.find((v) => v._id === id) ?? null; },
  }),
  ...over,
});

test('commission: standard product earns the seller their share of the excess', async () => {
  // The owner's worked example: floor 400, sells at 450, 90/10 split → 45.
  const product = standardProduct({ sellingPrice: 450, commission: withCommission() });
  const line = await resolveSaleLine(product, { quantity: 1 }, ctx());
  assert.equal(line.commissionAmount, 45);
});

test('commission: scales with quantity', async () => {
  const product = standardProduct({ sellingPrice: 450, commission: withCommission() });
  const line = await resolveSaleLine(product, { quantity: 3 }, ctx());
  assert.equal(line.commissionAmount, 135);
});

test('commission: absent config earns nothing', async () => {
  const line = await resolveSaleLine(standardProduct({ sellingPrice: 450 }), { quantity: 2 }, ctx());
  assert.equal(line.commissionAmount, 0);
});

test('commission: disabled config earns nothing', async () => {
  const product = standardProduct({ sellingPrice: 450, commission: withCommission({ enabled: false }) });
  const line = await resolveSaleLine(product, { quantity: 2 }, ctx());
  assert.equal(line.commissionAmount, 0);
});

test('commission: selling at or below the floor never goes negative', async () => {
  const product = standardProduct({ sellingPrice: 380, commission: withCommission() });
  const line = await resolveSaleLine(product, { quantity: 2 }, ctx());
  assert.equal(line.commissionAmount, 0);
});

test('commission: a 100% share hands the whole excess to the seller', async () => {
  const product = standardProduct({ sellingPrice: 450, commission: withCommission({ employeeSharePercent: 100 }) });
  const line = await resolveSaleLine(product, { quantity: 1 }, ctx());
  assert.equal(line.commissionAmount, 50);
});

test('commission: variable product pays on the negotiated price, not list', async () => {
  // The incentive only works if talking the customer up actually pays out.
  const product = standardProduct({
    productType: 'variable',
    sellingPrice: 420,
    minPrice: 400,
    maxPrice: 600,
    commission: withCommission(),
  });
  const line = await resolveSaleLine(product, { quantity: 1, unitPrice: 500 }, ctx());
  assert.equal(line.commissionAmount, 90);
});

test('commission: weighted product pays on the measured quantity', async () => {
  const product = standardProduct({
    productType: 'weighted',
    sellingPrice: 450,
    unitOfMeasure: 'kg',
    commission: withCommission(),
  });
  const line = await resolveSaleLine(product, { quantity: 2.5 }, ctx());
  assert.equal(line.commissionAmount, 112.5);
});

test('commission: service product earns on its overridden price', async () => {
  const product = standardProduct({
    productType: 'service',
    sellingPrice: 450,
    allowPriceOverride: true,
    trackInventory: false,
    commission: withCommission(),
  });
  const line = await resolveSaleLine(product, { quantity: 1, unitPrice: 600 }, ctx());
  assert.equal(line.commissionAmount, 180);
});

test('commission: free promotional units cannot mint commission', async () => {
  // Buy 2 get 1: 3 units, only 2 paid for. Revenue 900 against a 1200 floor,
  // so the line never clears the floor and correctly pays nothing — paying
  // here would come straight out of the shop's own margin.
  const product = standardProduct({
    sellingPrice: 450,
    quantity: 20,
    commission: withCommission(),
    promotions: [{ buyQty: 2, freeQty: 1, isActive: true, label: 'B2G1' }],
  });
  const line = await resolveSaleLine(product, { quantity: 3 }, ctx());
  assert.equal(line.subtotal, 900);
  assert.equal(line.commissionAmount, 0);
});

test('commission: configurable variant uses its own config', async () => {
  const product = configurable([
    { _id: 'v1', name: '500ml', sellingPrice: 450, quantity: 10, commission: withCommission() },
  ]);
  const line = await resolveSaleLine(product, { quantity: 2, variantId: 'v1' }, ctx());
  assert.equal(line.commissionAmount, 90);
});

test('commission: a variant with no config inherits the parent product config', async () => {
  const product = configurable(
    [{ _id: 'v1', name: '500ml', sellingPrice: 450, quantity: 10 }],
    { commission: withCommission() },
  );
  const line = await resolveSaleLine(product, { quantity: 1, variantId: 'v1' }, ctx());
  assert.equal(line.commissionAmount, 45);
});

test('commission: a variant config overrides the parent product config', async () => {
  const product = configurable(
    [{ _id: 'v1', name: '500ml', sellingPrice: 450, quantity: 10, commission: withCommission({ basePrice: 300 }) }],
    { commission: withCommission({ basePrice: 440 }) },
  );
  const line = await resolveSaleLine(product, { quantity: 1, variantId: 'v1' }, ctx());
  assert.equal(line.commissionAmount, 135);
});

test('commission: bundle earns on the bundle price', async () => {
  const soda = standardProduct({ _id: 'c1', name: 'Soda', costPrice: 40, quantity: 50 });
  const bundle = standardProduct({
    productType: 'bundle',
    sellingPrice: 450,
    bundleItems: [{ product: 'c1', quantity: 2 }],
    commission: withCommission(),
  });
  const line = await resolveSaleLine(bundle, { quantity: 1 }, ctx([['c1', soda]]));
  assert.equal(line.commissionAmount, 45);
});

test('commission: rounds to two decimals rather than drifting', async () => {
  const product = standardProduct({ sellingPrice: 450.555, commission: withCommission({ employeeSharePercent: 33 }) });
  const line = await resolveSaleLine(product, { quantity: 1 }, ctx());
  assert.equal(line.commissionAmount, 16.68);
});
