import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Quotation from '../src/models/Quotation.js';
import Customer from '../src/models/Customer.js';
import Product from '../src/models/Product.js';
import Sale from '../src/models/Sale.js';
import CreditTransaction from '../src/models/CreditTransaction.js';
import {
  createQuotation,
  getQuotations,
  getQuotationById,
  updateQuotation,
  declineQuotation,
  deleteQuotation,
  convertQuotation,
} from '../src/controllers/quotationController.js';
import { createQuotationSchema } from '../src/validations/quotationValidation.js';

// present() signs a JWT for every response, so any handler that reaches it
// needs a secret. Module scope, before any test — same reasoning as
// books.test.js's JWT_SECRET line.
process.env.RECEIPT_TOKEN_SECRET ||= 'test-secret';

/**
 * Quotation drafting/CRUD.
 *
 * `create_quotation` gates every write (draft/edit/decline/delete) — it has
 * no financial effect. The list and detail reads are also open to
 * `convert_quotation_to_sale` holders, who need to see what they're
 * converting even though they never drafted it themselves. Every query is
 * shop-scoped from the session, the same discipline as creditAuthorization.test.js.
 */

const SHOP_ID = '507f1f77bcf86cd799439011';
const CALLER_ID = '507f1f77bcf86cd799439012';
const CUSTOMER_ID = '507f1f77bcf86cd799439055';
const PRODUCT_ID = '507f1f77bcf86cd799439066';

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function makeReq({ role = 'staff', permissions = [], query = {}, body = {}, params = {}, shop = {}, headers = {} } = {}) {
  return {
    user: {
      _id: CALLER_ID,
      name: 'Amina',
      role,
      permissions,
      shop: { _id: SHOP_ID, taxRate: 0, ...shop },
    },
    query,
    body,
    params,
    headers,
  };
}

/** `Customer.findOne(...).lean()` — the only chain method the controller calls on it. */
function stubCustomerFindOne(doc, sink) {
  mock.method(Customer, 'findOne', (filter) => {
    sink?.push(filter);
    return { lean: async () => doc };
  });
}

/** `Product.find(...).lean()`. */
function stubProductFind(rows, sink) {
  mock.method(Product, 'find', (filter) => {
    sink?.push(filter);
    return { lean: async () => rows };
  });
}

/** `Quotation.findOne(...)` — called plain, with no `.lean()`, in the controller. */
function stubQuotationFindOne(doc, sink) {
  mock.method(Quotation, 'findOne', async (filter) => {
    sink?.push(filter);
    return doc;
  });
}

/** `Quotation.find(...).sort().skip().limit()` — awaited directly by paginatedResult(). */
function stubQuotationListFind(rows, sink) {
  mock.method(Quotation, 'find', (filter) => {
    sink?.push(filter);
    const chain = {
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
    };
    return chain;
  });
}

const stubCount = (n = 0) => mock.method(Quotation, 'countDocuments', async () => n);

/** A Quotation-document-like stub with `.set()`/`.save()`/`.deleteOne()`/a curated `.toObject()`. */
function quotationDoc(fields) {
  const doc = { ...fields };
  doc.set = (patch) => Object.assign(doc, patch);
  doc.save = async () => {};
  doc.deleteOne = async () => { doc.deleted = true; };
  doc.toObject = () => {
    const { set, save, deleteOne, toObject, ...plain } = doc;
    return plain;
  };
  return doc;
}

beforeEach(() => {
  mock.restoreAll();
});

// ── createQuotation ─────────────────────────────────────────────────────────

test('createQuotation: rejects a staff member without create_quotation, before any lookup', async () => {
  const filters = [];
  stubCustomerFindOne(null, filters);
  const res = makeRes();
  await createQuotation(makeReq({ permissions: ['record_sale'] }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(filters.length, 0, 'the database must not be touched before the permission check');
});

test('createQuotation: computes subtotal/tax/total from items rather than trusting the client', async () => {
  stubCustomerFindOne({ _id: CUSTOMER_ID, name: 'Jane', phone: '0700000000', email: '' });
  stubProductFind([{ _id: PRODUCT_ID, name: 'Haircut', sellingPrice: 300 }]);
  let created;
  mock.method(Quotation, 'create', async (doc) => {
    created = doc;
    return { ...doc, _id: 'q1', quoteNumber: 'QUO-2609-00001', toObject() { return { ...doc, _id: 'q1', quoteNumber: 'QUO-2609-00001' }; } };
  });

  const req = makeReq({
    role: 'owner',
    body: {
      customerId: CUSTOMER_ID,
      items: [
        { productId: PRODUCT_ID, name: 'Haircut', quantity: 2, unitPrice: 300 },
        { name: 'Custom trim', quantity: 1, unitPrice: 150 },
      ],
      validUntil: '2026-12-01',
      total: 999999, // must be ignored
    },
  });
  const res = makeRes();
  await createQuotation(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.subtotal, 750);
  assert.notEqual(res.body.data.total, 999999);
  assert.equal(res.body.data.total, 750);
  assert.match(res.body.data.quoteNumber, /^QUO-\d{4}-\d{5}$/);
  assert.equal(typeof res.body.data.publicToken, 'string');
  // The catalog line's name/price come from the Product, never the client.
  assert.equal(created.items[0].name, 'Haircut');
  assert.equal(created.items[0].unitPrice, 300);
});

test('createQuotation: a customer outside this shop is not found', async () => {
  const filters = [];
  stubCustomerFindOne(null, filters);
  const res = makeRes();
  await createQuotation(makeReq({ role: 'owner', body: { customerId: CUSTOMER_ID, items: [{ name: 'X', quantity: 1, unitPrice: 1 }], validUntil: '2026-12-01' } }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(String(filters[0].shop), SHOP_ID);
});

test('createQuotation: a productId outside this shop is refused with 400, not a 500', async () => {
  stubCustomerFindOne({ _id: CUSTOMER_ID, name: 'Jane' });
  stubProductFind([]); // nothing found for this shop
  const res = makeRes();
  await createQuotation(makeReq({ role: 'owner', body: { customerId: CUSTOMER_ID, items: [{ productId: PRODUCT_ID, quantity: 1 }], validUntil: '2026-12-01' } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /not found in this shop/);
});

// ── quotationValidation ──────────────────────────────────────────────────────

test('createQuotationSchema: an item needs a productId or a usable name, never neither', () => {
  const { error } = createQuotationSchema.validate({
    customerId: CUSTOMER_ID,
    items: [{ quantity: 1, unitPrice: 100 }],
    validUntil: '2026-12-01',
  });
  assert.ok(error);
});

test('createQuotationSchema: unitPrice is required for a custom line, optional for a catalog line', () => {
  assert.ok(createQuotationSchema.validate({
    customerId: CUSTOMER_ID, items: [{ name: 'Custom', quantity: 1 }], validUntil: '2026-12-01',
  }).error);
  assert.equal(createQuotationSchema.validate({
    customerId: CUSTOMER_ID, items: [{ productId: PRODUCT_ID, quantity: 1 }], validUntil: '2026-12-01',
  }).error, undefined);
});

test('createQuotationSchema: a client-sent total cannot smuggle through', () => {
  const { error } = createQuotationSchema.validate({
    customerId: CUSTOMER_ID,
    items: [{ productId: PRODUCT_ID, quantity: 1 }],
    validUntil: '2026-12-01',
    total: 999999,
  });
  assert.ok(error);
});

// ── getQuotations ────────────────────────────────────────────────────────────

test('getQuotations: refused without create_quotation or convert_quotation_to_sale, before any query', async () => {
  const filters = [];
  stubQuotationListFind([], filters);
  const res = makeRes();
  await getQuotations(makeReq({ permissions: ['record_sale'] }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(filters.length, 0);
});

test('getQuotations: a convert_quotation_to_sale holder may list without create_quotation', async () => {
  const filters = [];
  stubQuotationListFind([], filters);
  stubCount(0);
  const res = makeRes();
  await getQuotations(makeReq({ permissions: ['convert_quotation_to_sale'] }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(filters.length, 1);
});

test('getQuotations: scoped to this shop, and a status filter narrows the query', async () => {
  const filters = [];
  stubQuotationListFind([{ _id: 'q1', quoteNumber: 'QUO-2609-00001', toObject() { return this; } }], filters);
  stubCount(1);

  const res = makeRes();
  await getQuotations(makeReq({ role: 'owner', query: { status: 'draft' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(String(filters[0].shop), SHOP_ID);
  assert.equal(filters[0].status, 'draft');
  assert.equal(res.body.pagination.total, 1);
});

test('getQuotations: a search term is escaped before it reaches a regex', async () => {
  const filters = [];
  stubQuotationListFind([], filters);
  stubCount(0);

  await getQuotations(makeReq({ role: 'owner', query: { search: 'a.*(b' } }), makeRes());

  assert.equal(filters[0].$or[0].quoteNumber.$regex, 'a\\.\\*\\(b');
});

// ── getQuotationById ─────────────────────────────────────────────────────────

test('getQuotationById: refused without create_quotation or convert_quotation_to_sale, before any lookup', async () => {
  const filters = [];
  stubQuotationFindOne(null, filters);
  const res = makeRes();
  await getQuotationById(makeReq({ permissions: [] }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(filters.length, 0);
});

test('getQuotationById: another shop\'s quotation, or a nonexistent one, is simply not found', async () => {
  const filters = [];
  stubQuotationFindOne(null, filters);
  const res = makeRes();
  await getQuotationById(makeReq({ role: 'owner', params: { id: 'q1' } }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(String(filters[0].shop), SHOP_ID);
});

test('getQuotationById: returns the quotation with a signed publicToken', async () => {
  stubQuotationFindOne(quotationDoc({ _id: 'q1', status: 'draft', total: 750 }));
  const res = makeRes();
  await getQuotationById(makeReq({ role: 'owner', params: { id: 'q1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.total, 750);
  assert.equal(typeof res.body.data.publicToken, 'string');
});

// ── updateQuotation ──────────────────────────────────────────────────────────

test('updateQuotation: rejects a staff member without create_quotation, before any lookup', async () => {
  const filters = [];
  stubQuotationFindOne(null, filters);
  const res = makeRes();
  await updateQuotation(makeReq({ permissions: [] }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(filters.length, 0);
});

test('updateQuotation: only a draft quotation may be edited', async () => {
  const filters = [];
  stubQuotationFindOne(null, filters); // findOne({..., status: 'draft'}) matched nothing
  const res = makeRes();
  await updateQuotation(makeReq({ role: 'owner', params: { id: 'q1' }, body: { customerId: CUSTOMER_ID, items: [{ name: 'X', quantity: 1, unitPrice: 1 }], validUntil: '2026-12-01' } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(String(filters[0].shop), SHOP_ID);
  assert.equal(filters[0].status, 'draft');
});

test('updateQuotation: a customer outside this shop is not found', async () => {
  stubQuotationFindOne(quotationDoc({ _id: 'q1', status: 'draft' }));
  const filters = [];
  stubCustomerFindOne(null, filters);
  const res = makeRes();
  await updateQuotation(makeReq({ role: 'owner', params: { id: 'q1' }, body: { customerId: CUSTOMER_ID, items: [{ name: 'X', quantity: 1, unitPrice: 1 }], validUntil: '2026-12-01' } }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(String(filters[0].shop), SHOP_ID);
});

test('updateQuotation: recomputes subtotal/tax/total from the new items', async () => {
  stubQuotationFindOne(quotationDoc({ _id: 'q1', status: 'draft' }));
  stubCustomerFindOne({ _id: CUSTOMER_ID, name: 'Jane' });
  stubProductFind([{ _id: PRODUCT_ID, name: 'Haircut', sellingPrice: 300 }]);

  const res = makeRes();
  await updateQuotation(makeReq({
    role: 'owner',
    shop: { taxRate: 10 },
    params: { id: 'q1' },
    body: {
      customerId: CUSTOMER_ID,
      items: [{ productId: PRODUCT_ID, quantity: 1 }],
      validUntil: '2026-12-01',
      total: 1, // must be ignored
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.subtotal, 300);
  assert.equal(res.body.data.taxAmount, 30);
  assert.equal(res.body.data.total, 330);
});

// ── declineQuotation ─────────────────────────────────────────────────────────

test('declineQuotation: rejects a staff member without create_quotation', async () => {
  const filters = [];
  mock.method(Quotation, 'findOneAndUpdate', async (filter) => { filters.push(filter); return null; });
  const res = makeRes();
  await declineQuotation(makeReq({ permissions: [] }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(filters.length, 0);
});

test('declineQuotation: only a draft quotation may be declined', async () => {
  const filters = [];
  mock.method(Quotation, 'findOneAndUpdate', async (filter) => { filters.push(filter); return null; });
  const res = makeRes();
  await declineQuotation(makeReq({ role: 'owner', params: { id: 'q1' } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(String(filters[0].shop), SHOP_ID);
  assert.equal(filters[0].status, 'draft');
});

test('declineQuotation: transitions a draft to declined', async () => {
  mock.method(Quotation, 'findOneAndUpdate', async () => quotationDoc({ _id: 'q1', status: 'declined' }));
  const res = makeRes();
  await declineQuotation(makeReq({ role: 'owner', params: { id: 'q1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'declined');
});

// ── deleteQuotation ──────────────────────────────────────────────────────────

test('deleteQuotation: rejects a staff member without create_quotation, before any lookup', async () => {
  const filters = [];
  stubQuotationFindOne(null, filters);
  const res = makeRes();
  await deleteQuotation(makeReq({ permissions: [] }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(filters.length, 0);
});

test('deleteQuotation: another shop\'s quotation, or a nonexistent one, is simply not found', async () => {
  const filters = [];
  stubQuotationFindOne(null, filters);
  const res = makeRes();
  await deleteQuotation(makeReq({ role: 'owner', params: { id: 'q1' } }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(String(filters[0].shop), SHOP_ID);
});

test('deleteQuotation: refuses to delete a converted quotation', async () => {
  const doc = quotationDoc({ _id: 'q1', status: 'converted', convertedSale: 'sale1' });
  stubQuotationFindOne(doc);
  const res = makeRes();
  await deleteQuotation(makeReq({ role: 'owner', params: { id: 'q1' } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(doc.deleted, undefined, 'nothing may be deleted');
});

test('deleteQuotation: deletes a draft quotation', async () => {
  const doc = quotationDoc({ _id: 'q1', status: 'draft' });
  stubQuotationFindOne(doc);
  const res = makeRes();
  await deleteQuotation(makeReq({ role: 'owner', params: { id: 'q1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(doc.deleted, true);
});

// ── convertQuotation ─────────────────────────────────────────────────────────
//
// convertQuotation calls the real createSaleTransaction (Task 6) rather than
// a mock of it, the same way createSale.test.js exercises it end to end — so
// these tests stub mongoose.startSession / Product / Sale / Customer /
// CreditTransaction, not createSaleTransaction itself.

/** A draft quotation with one custom/service line, so createSaleTransaction's
 * product lookup never needs anything but an empty Product.find result. */
function draftQuotation(overrides = {}) {
  return {
    _id: 'q1',
    status: 'draft',
    customer: CUSTOMER_ID,
    items: [{ name: 'Haircut', quantity: 1, unitPrice: 500 }],
    ...overrides,
  };
}

/** `mongoose.startSession()` — a trivial passthrough, same as saleCreation.test.js.
 * `sink`, if given, collects each session object so a test can assert that a
 * later call (e.g. beforeCommit's Quotation.findOneAndUpdate) used the very
 * same session the transaction opened, not a separate one. */
function stubSession(sink) {
  mock.method(mongoose, 'startSession', async () => {
    const session = { withTransaction: async (fn) => fn(), endSession() {} };
    sink?.push(session);
    return session;
  });
}

/** `Product.find(...).session(session)` — the chain createSaleTransaction calls,
 * distinct from stubProductFind's `.lean()` chain used by resolveQuotationItems. */
function stubProductFindForSale(rows = []) {
  mock.method(Product, 'find', () => ({ session: async () => rows }));
}

/** `Customer.findOne(...).select(...).lean()` — createSaleTransaction attaches
 * the quotation's customer to the sale on every conversion, credit or not. */
function stubSaleCustomer(doc) {
  mock.method(Customer, 'findOne', () => ({ select: () => ({ lean: async () => doc }) }));
}

test('convertQuotation: rejects a staff member without convert_quotation_to_sale, before any lookup', async () => {
  const filters = [];
  stubQuotationFindOne(null, filters);
  const res = makeRes();
  await convertQuotation(makeReq({ permissions: ['create_quotation'], params: { id: 'q1' }, body: { paymentMethod: 'cash' } }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(filters.length, 0, 'the database must not be touched before the permission check');
});

test('convertQuotation: a nonexistent or another shop\'s quotation is simply not found', async () => {
  const filters = [];
  stubQuotationFindOne(null, filters);
  const res = makeRes();
  await convertQuotation(makeReq({ role: 'owner', params: { id: 'q1' }, body: { paymentMethod: 'cash' } }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(String(filters[0].shop), SHOP_ID);
});

test('convertQuotation: rejects converting an already-converted or declined quotation', async () => {
  stubQuotationFindOne(draftQuotation({ status: 'declined' }));
  const res = makeRes();
  await convertQuotation(makeReq({ role: 'owner', params: { id: 'q1' }, body: { paymentMethod: 'cash' } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /already declined/);
});

test('convertQuotation: still requires make_credit_sale to convert to a credit sale', async () => {
  stubQuotationFindOne(draftQuotation());
  mock.method(Sale, 'create', async () => { throw new Error('Sale.create must not be called before the credit-permission gate'); });
  const res = makeRes();
  await convertQuotation(makeReq({ permissions: ['convert_quotation_to_sale'], params: { id: 'q1' }, body: { paymentMethod: 'credit' } }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'CREDIT_PERMISSION_DENIED');
});

test('convertQuotation: marks the quotation converted and links the new sale', async () => {
  const q = draftQuotation();
  stubQuotationFindOne(q);
  stubSession();
  stubProductFindForSale();
  stubSaleCustomer({ _id: CUSTOMER_ID, name: 'Jane' });
  let created;
  mock.method(Sale, 'create', async (docs) => {
    created = docs[0];
    return [{ ...created, _id: 'sale1', toObject: () => ({ ...created, _id: 'sale1' }) }];
  });
  let updateFilter;
  let updateDoc;
  mock.method(Quotation, 'findOneAndUpdate', async (filter, update) => {
    updateFilter = filter;
    updateDoc = update;
    return { ...q, status: 'converted', convertedSale: 'sale1' };
  });

  const res = makeRes();
  await convertQuotation(makeReq({ role: 'owner', params: { id: 'q1' }, body: { paymentMethod: 'cash' } }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(created.paymentMethod, 'cash');
  assert.equal(created.totalAmount, 500);
  assert.equal(res.body.data._id, 'sale1');
  assert.equal(String(res.body.data.quotationId), 'q1');
  assert.equal(res.body.message, 'Quotation converted to a sale.');
  assert.equal(String(updateFilter._id), 'q1');
  assert.equal(updateFilter.status, 'draft');
  assert.equal(updateDoc.$set.status, 'converted');
  assert.equal(String(updateDoc.$set.convertedSale), 'sale1');
});

test('convertQuotation: converts to a credit sale when make_credit_sale is also granted', async () => {
  const q = draftQuotation();
  stubQuotationFindOne(q);
  stubSession();
  stubProductFindForSale();
  mock.method(Sale, 'create', async (docs) => [{ ...docs[0], _id: 'sale1', toObject: () => ({ ...docs[0], _id: 'sale1' }) }]);
  mock.method(Quotation, 'findOneAndUpdate', async () => ({ ...q, status: 'converted', convertedSale: 'sale1' }));
  mock.method(Customer, 'findOne', () => ({ select: () => ({ lean: async () => ({ _id: CUSTOMER_ID, name: 'Jane', isActive: true }) }) }));
  mock.method(Customer, 'findOneAndUpdate', async () => ({ _id: CUSTOMER_ID, name: 'Jane', credit: { outstanding: 500, limit: null } }));
  mock.method(CreditTransaction, 'create', async (docs) => [{ ...docs[0], _id: 'tx1' }]);
  mock.method(CreditTransaction, 'find', () => ({
    select() { return this; }, sort() { return this; }, session() { return this; }, lean: async () => [],
  }));
  mock.method(CreditTransaction, 'exists', () => ({ session: async () => null }));

  const req = makeReq({
    permissions: ['convert_quotation_to_sale', 'make_credit_sale'],
    shop: { creditSettings: { enabled: true, defaultCreditLimit: 3000, defaultCollectionPeriodDays: 7, productPolicy: 'ALL_PRODUCTS', overduePolicy: 'BLOCK' } },
    params: { id: 'q1' },
    body: { paymentMethod: 'credit' },
  });
  const res = makeRes();
  await convertQuotation(req, res);

  assert.equal(res.statusCode, 201);
  assert.ok(res.body.data.credit, 'response must carry the credit summary, same as a till credit sale');
  assert.equal(res.body.message, "Sale recorded on Jane's account.");
});

test('convertQuotation: beforeCommit\'s atomic guard rejects a race the initial draft check missed, without a second Sale.create', async () => {
  // Quotation.findOne always answers 'draft' here — modelling a request that
  // read the quotation before a concurrent convert committed. The initial
  // status check alone would let this through; only the status-filtered
  // findOneAndUpdate inside beforeCommit — running on the transaction's own
  // session — stops a second Sale from being created.
  mock.method(Quotation, 'findOne', async () => draftQuotation());
  const sessions = [];
  stubSession(sessions);
  stubProductFindForSale();
  stubSaleCustomer({ _id: CUSTOMER_ID, name: 'Jane' });
  let saleCreateCalls = 0;
  mock.method(Sale, 'create', async (docs) => {
    saleCreateCalls += 1;
    return [{ ...docs[0], _id: 'sale-x', toObject: () => ({ ...docs[0], _id: 'sale-x' }) }];
  });
  let updateOptions;
  mock.method(Quotation, 'findOneAndUpdate', async (filter, update, options) => {
    updateOptions = options;
    return null; // another convert already won — the DB no longer matches status: 'draft'
  });

  const res = makeRes();
  await convertQuotation(makeReq({ role: 'owner', params: { id: 'q1' }, body: { paymentMethod: 'cash' } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /already converted/);
  assert.equal(saleCreateCalls, 1, 'the sale attempt happens inside the transaction, before beforeCommit aborts it');
  assert.equal(updateOptions.session, sessions[0], "beforeCommit's update must run on the transaction's own session, not a separate one");
});

test('convertQuotation: is idempotent — two sequential converts of the same quotation produce exactly one Sale', async () => {
  const q = draftQuotation({ _id: 'q2' });
  // Each call re-reads the current (mutated-in-place) status, the way a real
  // findOne would re-read the document — not a snapshot frozen at test setup.
  mock.method(Quotation, 'findOne', async () => ({ ...q }));
  stubSession();
  stubProductFindForSale();
  stubSaleCustomer({ _id: CUSTOMER_ID, name: 'Jane' });
  let saleCreateCalls = 0;
  mock.method(Sale, 'create', async (docs) => {
    saleCreateCalls += 1;
    return [{ ...docs[0], _id: `sale-${saleCreateCalls}`, toObject: () => ({ ...docs[0], _id: `sale-${saleCreateCalls}` }) }];
  });
  mock.method(Quotation, 'findOneAndUpdate', async (filter, update) => {
    if (q.status !== 'draft') return null; // the atomic guard: already converted
    q.status = 'converted';
    q.convertedSale = update.$set.convertedSale;
    return { ...q };
  });

  const makeConvertReq = () => makeReq({ role: 'owner', params: { id: 'q2' }, body: { paymentMethod: 'cash' } });
  const first = makeRes();
  await convertQuotation(makeConvertReq(), first);
  const second = makeRes();
  await convertQuotation(makeConvertReq(), second);

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 400);
  assert.match(second.body.message, /already converted/);
  assert.equal(saleCreateCalls, 1, 'the duplicate request must not create a second Sale');
});
