import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Quotation from '../src/models/Quotation.js';
import { getPublicQuotation, getPublicQuotationPdf } from '../src/controllers/publicController.js';
import { signQuotationToken } from '../src/utils/quotationToken.js';

// signQuotationToken/verifyQuotationToken sign a JWT for every call, so any
// test that reaches them needs a secret — same reasoning as
// quotationCrud.test.js's RECEIPT_TOKEN_SECRET line.
process.env.RECEIPT_TOKEN_SECRET ||= 'test-secret';

/**
 * GET /public/quotation/:token — the unauthenticated page a customer opens
 * from a shared link. No auth, no shop scoping (the token itself is the
 * capability), so the guarantee this endpoint must uphold is redaction:
 * never productId, never a cost/commission field, no matter what shape the
 * stored document has.
 */

const QUOTATION_ID = '507f1f77bcf86cd799439077';

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    send(body) { this.body = body; return this; },
  };
}

function makeReq(token) {
  return { params: { token } };
}

/** `Quotation.findById(...).populate(...)` — the only chain the controller calls. */
function stubQuotationFindById(doc, sink) {
  mock.method(Quotation, 'findById', (id) => {
    sink?.push(id);
    return { populate: async () => doc };
  });
}

beforeEach(() => {
  mock.restoreAll();
});

test('getPublicQuotation: never exposes productId or cost fields, even when the stored item carries them', async () => {
  const token = signQuotationToken(QUOTATION_ID);
  stubQuotationFindById({
    _id: QUOTATION_ID,
    quoteNumber: 'QUO-2609-00001',
    shop: { name: 'Jane\'s Salon', phone: '0700000000', address: '5th Ave, Nairobi', logoUrl: 'https://x/logo.png', currency: 'KES' },
    customerSnapshot: { name: 'Amina', phone: '0711111111', email: '' },
    items: [
      {
        productId: '507f1f77bcf86cd799439066',
        name: 'Haircut',
        description: 'Basic trim',
        quantity: 2,
        unitPrice: 300,
        subtotal: 600,
        unitCost: 100,
        costTotal: 200,
      },
    ],
    subtotal: 600,
    taxRate: 0,
    taxAmount: 0,
    total: 600,
    notes: '',
    validUntil: new Date('2026-12-01'),
    status: 'draft',
    createdAt: new Date('2026-09-01'),
  });

  const res = makeRes();
  await getPublicQuotation(makeReq(token), res);

  assert.equal(res.statusCode, 200);
  const json = JSON.stringify(res.body.data);
  assert.doesNotMatch(json, /productId/);
  assert.doesNotMatch(json, /unitCost/);
  assert.doesNotMatch(json, /costTotal/);

  // And the fields the page actually needs are present.
  assert.equal(res.body.data.quoteNumber, 'QUO-2609-00001');
  assert.equal(res.body.data.shopName, 'Jane\'s Salon');
  assert.equal(res.body.data.shopPhone, '0700000000');
  assert.equal(res.body.data.shopAddress, '5th Ave, Nairobi');
  assert.equal(res.body.data.shopLogoUrl, 'https://x/logo.png');
  assert.deepEqual(res.body.data.customerSnapshot, { name: 'Amina', phone: '0711111111', email: '' });
  assert.deepEqual(res.body.data.items[0], {
    name: 'Haircut',
    description: 'Basic trim',
    quantity: 2,
    unitPrice: 300,
    subtotal: 600,
  });
  assert.equal(res.body.data.total, 600);
  assert.equal(res.body.data.status, 'draft');
});

test('getPublicQuotation: returns 400 for a garbage token, without touching the database', async () => {
  const filters = [];
  stubQuotationFindById(null, filters);
  const res = makeRes();
  await getPublicQuotation(makeReq('not-a-real-token'), res);

  assert.equal(res.statusCode, 400);
  assert.equal(filters.length, 0, 'a token that fails verification must never reach the database');
});

test('getPublicQuotation: returns 404 when the token is valid but the quotation is gone', async () => {
  stubQuotationFindById(null);
  const token = signQuotationToken(QUOTATION_ID);
  const res = makeRes();
  await getPublicQuotation(makeReq(token), res);

  assert.equal(res.statusCode, 404);
});

// ── getPublicQuotationPdf ────────────────────────────────────────────────────

/** A quotation-with-populated-shop shape carrying every field renderQuotationPdf's input needs. */
function pdfQuotation(shopOverrides = {}) {
  return {
    _id: QUOTATION_ID,
    quoteNumber: 'QUO-2609-00001',
    shop: { name: 'Jane\'s Salon', phone: '0700000000', address: '5th Ave, Nairobi', currency: 'KES', quotationTemplate: 'minimal', ...shopOverrides },
    customerSnapshot: { name: 'Amina', phone: '0711111111', email: '' },
    items: [{ name: 'Haircut', description: '', quantity: 1, unitPrice: 500, subtotal: 500 }],
    subtotal: 500,
    taxRate: 0,
    taxAmount: 0,
    total: 500,
    notes: '',
    validUntil: new Date('2026-12-01'),
    createdAt: new Date('2026-09-01'),
  };
}

test('getPublicQuotationPdf: returns 400 for a garbage token, without touching the database', async () => {
  const filters = [];
  stubQuotationFindById(null, filters);
  const res = makeRes();
  await getPublicQuotationPdf(makeReq('not-a-real-token'), res);

  assert.equal(res.statusCode, 400);
  assert.equal(filters.length, 0, 'a token that fails verification must never reach the database');
});

test('getPublicQuotationPdf: returns 404 when the token is valid but the quotation is gone', async () => {
  stubQuotationFindById(null);
  const token = signQuotationToken(QUOTATION_ID);
  const res = makeRes();
  await getPublicQuotationPdf(makeReq(token), res);

  assert.equal(res.statusCode, 404);
});

test('getPublicQuotationPdf: streams a real PDF buffer with no auth', async () => {
  stubQuotationFindById(pdfQuotation());
  const token = signQuotationToken(QUOTATION_ID);
  const res = makeRes();
  await getPublicQuotationPdf(makeReq(token), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.match(res.headers['Content-Disposition'], /QUO-2609-00001\.pdf/);
  assert.equal(Buffer.isBuffer(res.body), true);
  assert.equal(res.body.subarray(0, 5).toString(), '%PDF-');
});

test('getPublicQuotationPdf: defaults to the classic template when the shop predates quotationTemplate', async () => {
  stubQuotationFindById(pdfQuotation({ quotationTemplate: undefined }));
  const token = signQuotationToken(QUOTATION_ID);
  const res = makeRes();
  await getPublicQuotationPdf(makeReq(token), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subarray(0, 5).toString(), '%PDF-');
});
