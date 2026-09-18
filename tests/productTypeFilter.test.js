import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Product from '../src/models/Product.js';
import { getProducts } from '../src/controllers/productController.js';

function makeRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

function fakeProduct(overrides) {
  const doc = { _id: new mongoose.Types.ObjectId(), name: 'x', productType: 'standard', ...overrides };
  return { ...doc, toObject: () => doc };
}

test('includeTypes narrows the query to the given productType values', async () => {
  const filters = [];
  mock.method(Product, 'find', (filter) => {
    filters.push(filter);
    return { skip() { return this; }, limit() { return this; }, sort() { return this; }, then: (res) => Promise.resolve([fakeProduct({ productType: 'service' })]).then(res) };
  });
  mock.method(Product, 'countDocuments', async () => 1);

  const req = { user: { role: 'owner', shop: { _id: 'shop1' } }, query: { includeTypes: 'service' } };
  const res = makeRes();
  await getProducts(req, res);

  assert.deepEqual(filters[0].productType, { $in: ['service'] });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.data.every((p) => p.productType === 'service'));
});
