import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Quotation from '../src/models/Quotation.js';
import Customer from '../src/models/Customer.js';
import Product from '../src/models/Product.js';
import {
  createQuotation,
  getQuotations,
  getQuotationById,
  updateQuotation,
  declineQuotation,
  deleteQuotation,
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

function makeReq({ role = 'staff', permissions = [], query = {}, body = {}, params = {}, shop = {} } = {}) {
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
