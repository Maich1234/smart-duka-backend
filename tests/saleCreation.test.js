import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Product from '../src/models/Product.js';
import Sale from '../src/models/Sale.js';
import Customer from '../src/models/Customer.js';
import CreditTransaction from '../src/models/CreditTransaction.js';
import MpesaTransaction from '../src/models/MpesaTransaction.js';
import { createSale } from '../src/controllers/saleController.js';

// createSale signs a JWT receipt token on every successful response, so any
// handler that reaches it needs a secret. Module scope, before any test —
// same reasoning as quotationCrud.test.js's identical line.
process.env.RECEIPT_TOKEN_SECRET ||= 'test-secret';

function makeRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

function makeReq({ items, paymentMethod = 'cash', customerId, mpesaTransactionId, headers = {} } = {}) {
  return {
    user: {
      _id: 'user1', name: 'Amina', role: 'staff', permissions: ['record_sale', 'make_credit_sale'], commissionEligible: false,
      shop: { _id: 'shop1', currency: 'KES', paymentMethods: undefined, creditSettings: { enabled: true, defaultCreditLimit: 3000, defaultCollectionPeriodDays: 7, productPolicy: 'ALL_PRODUCTS', overduePolicy: 'BLOCK' } },
    },
    body: { items, paymentMethod, customerId, mpesaTransactionId },
    headers,
  };
}

function stubSession() {
  mock.method(mongoose, 'startSession', async () => ({ withTransaction: async (fn) => fn(), endSession() {} }));
}

beforeEach(() => { mock.restoreAll(); stubSession(); });

// trackInventory: false is what keeps this fixture safe to run resolveSaleLine
// against for real (pricingEngine.js's stock-adjustment helper returns
// immediately when trackInventory is false — see line ~50) — no need to mock
// resolveSaleLine itself, which sidesteps the open question of whether
// mock.method reliably intercepts a plain named ESM function export the way
// it reliably does a method on a shared Mongoose model object (used freely
// below for Product/Sale/Customer/CreditTransaction, which are always the
// same object reference across every importer, live-binding subtleties
// aside). If resolveSaleLine's real behavior needs more product fields than
// listed here to run cleanly, add them — do not fall back to mocking it
// without first confirming mock.method actually intercepts the named import
// inside saleController.js in this Node version; if it silently doesn't,
// every assertion below would be exercising the mock's fake numbers instead
// of the real pricing path, defeating the point of a characterization test.
const PRODUCT = { _id: new mongoose.Types.ObjectId(), name: 'Haircut', sellingPrice: 500, productType: 'service', quantity: 0, trackInventory: false, save: async () => {} };

test('cash sale: creates a Sale with the resolved total', async () => {
  mock.method(Product, 'find', () => ({ session: async () => [PRODUCT] }));
  let created;
  mock.method(Sale, 'create', async (docs) => { created = docs[0]; return [{ ...created, _id: 'sale1', toObject: () => ({ ...created, _id: 'sale1' }) }]; });

  const req = makeReq({ items: [{ productId: String(PRODUCT._id), quantity: 1 }] });
  const res = makeRes();
  await createSale(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(created.totalAmount, 500);
  assert.equal(created.paymentMethod, 'cash');
});

test('credit sale: books a debt via bookDebt and returns the account summary', async () => {
  mock.method(Product, 'find', () => ({ session: async () => [PRODUCT] }));
  mock.method(Sale, 'create', async (docs) => [{ ...docs[0], _id: 'sale1', toObject: () => ({ ...docs[0], _id: 'sale1' }) }]);
  mock.method(Customer, 'findOne', () => ({ select: () => ({ lean: async () => ({ _id: 'cust1', name: 'Jane', isActive: true }) }) }));
  mock.method(Customer, 'findOneAndUpdate', async () => ({ _id: 'cust1', name: 'Jane', credit: { outstanding: 500, limit: null } }));
  mock.method(CreditTransaction, 'create', async (docs) => [{ ...docs[0], _id: 'tx1' }]);
  // recomputeCustomerCredit (called at the end of bookDebt) re-reads the
  // ledger and re-writes the rollup — not part of the credit-sale assertions
  // below, but left unstubbed it reaches the real CreditTransaction.find /
  // .exists and Customer.findOneAndUpdate against a database this suite never
  // connects to. creditService.test.js stubs these same two calls (stubFind /
  // stubExists) around every bookDebt call for the same reason.
  mock.method(CreditTransaction, 'find', () => ({
    select() { return this; }, sort() { return this; }, session() { return this; }, lean: async () => [],
  }));
  mock.method(CreditTransaction, 'exists', () => ({ session: async () => null }));

  const req = makeReq({ items: [{ productId: String(PRODUCT._id), quantity: 1 }], paymentMethod: 'credit', customerId: 'cust1' });
  const res = makeRes();
  await createSale(req, res);

  assert.equal(res.statusCode, 201);
  assert.ok(res.body.data.credit, 'response must carry the credit summary the till confirmation sheet displays');
});

test('rejects a second sale linking an already-claimed M-Pesa transaction', async () => {
  mock.method(MpesaTransaction, 'findOne', async () => ({ _id: 'mtx1', status: 'success', saleId: 'sale-already' }));

  const req = makeReq({ items: [{ productId: String(PRODUCT._id), quantity: 1 }], paymentMethod: 'mpesa', mpesaTransactionId: 'mtx1' });
  const res = makeRes();
  await createSale(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /already been linked/);
});

test('rejects an item referencing a product outside this shop', async () => {
  mock.method(Product, 'find', () => ({ session: async () => [] })); // nothing found for this shop

  const req = makeReq({ items: [{ productId: String(new mongoose.Types.ObjectId()), quantity: 1 }] });
  const res = makeRes();
  await createSale(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /not found in this shop/);
});
