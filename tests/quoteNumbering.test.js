import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { nextQuoteNumber, formatQuoteNumber } from '../src/services/quoteNumberService.js';
import Quotation from '../src/models/Quotation.js';

// A stand-in for the Shop model that models findByIdAndUpdate's atomicity:
// the increment and the read of the new value happen together, so interleaved
// callers cannot observe the same counter. Mirrors the fake model in
// tests/invoiceNumbering.test.js — same property under test, same reason.
const fakeShopModel = (seeds = { s1: 0 }) => {
  const counters = { ...seeds };
  const calls = [];

  return {
    calls,
    counters,
    async findByIdAndUpdate(id, update, options) {
      calls.push({ id, update, options });
      if (!(id in counters)) return null;
      counters[id] += update.$inc.quoteNumberSeq;
      return { quoteNumberSeq: counters[id] };
    },
  };
};

const JAN_2026 = new Date('2026-01-15T10:00:00Z');
const SEP_2026 = new Date('2026-09-16T10:00:00Z');

test('formats as QUO-YYMM-NNNNN with zero padding', () => {
  assert.equal(formatQuoteNumber(1, SEP_2026), 'QUO-2609-00001');
  assert.equal(formatQuoteNumber(7, SEP_2026), 'QUO-2609-00007');
  assert.equal(formatQuoteNumber(42, SEP_2026), 'QUO-2609-00042');
  assert.equal(formatQuoteNumber(99999, SEP_2026), 'QUO-2609-99999');
});

test('pads the month, so January is 01 not 1', () => {
  assert.equal(formatQuoteNumber(1, JAN_2026), 'QUO-2601-00001');
});

test('numbers beyond five digits are not truncated', () => {
  // padStart only ever pads. A shop past 99,999 quotations keeps a valid,
  // unique number rather than silently wrapping back into a used one.
  assert.equal(formatQuoteNumber(100000, SEP_2026), 'QUO-2609-100000');
});

test('two shops each start at 00001 without colliding', async () => {
  // Same per-shop-not-global uniqueness fix as invoiceNumberService: both
  // shops legitimately want QUO-2609-00001, and per-shop counters plus the
  // compound { shop, quoteNumber } index make that storable for both.
  const Shop = fakeShopModel({ shopA: 0, shopB: 0 });

  const a = await nextQuoteNumber('shopA', { ShopModel: Shop, now: SEP_2026 });
  const b = await nextQuoteNumber('shopB', { ShopModel: Shop, now: SEP_2026 });

  assert.equal(a, 'QUO-2609-00001');
  assert.equal(b, 'QUO-2609-00001');
});

test('one shop increments across sequential quotations', async () => {
  const Shop = fakeShopModel({ shopA: 0 });

  const first = await nextQuoteNumber('shopA', { ShopModel: Shop, now: SEP_2026 });
  const second = await nextQuoteNumber('shopA', { ShopModel: Shop, now: SEP_2026 });
  const third = await nextQuoteNumber('shopA', { ShopModel: Shop, now: SEP_2026 });

  assert.deepEqual(
    [first, second, third],
    ['QUO-2609-00001', 'QUO-2609-00002', 'QUO-2609-00003'],
  );
});

test('concurrent quotations in one shop never share a number', async () => {
  // The countDocuments() failure mode this replaces: N concurrent reads all
  // see the same count and all build the same number.
  const Shop = fakeShopModel({ shopA: 0 });

  const numbers = await Promise.all(
    Array.from({ length: 10 }, () =>
      nextQuoteNumber('shopA', { ShopModel: Shop, now: SEP_2026 })),
  );

  assert.equal(new Set(numbers).size, 10, 'every concurrent quotation must get a distinct number');
  assert.equal(Shop.counters.shopA, 10);
});

test('continues from a seeded counter rather than restarting', async () => {
  const Shop = fakeShopModel({ shopA: 137 });
  const next = await nextQuoteNumber('shopA', { ShopModel: Shop, now: SEP_2026 });
  assert.equal(next, 'QUO-2609-00138');
});

test('the month prefix changes but the counter does not reset', async () => {
  // Numbering is lifetime-per-shop; YYMM is display only.
  const Shop = fakeShopModel({ shopA: 0 });

  const january = await nextQuoteNumber('shopA', { ShopModel: Shop, now: JAN_2026 });
  const september = await nextQuoteNumber('shopA', { ShopModel: Shop, now: SEP_2026 });

  assert.equal(january, 'QUO-2601-00001');
  assert.equal(september, 'QUO-2609-00002');
});

test('joins the caller transaction when a session is given', async () => {
  // Quotation's pre-save hook passes this.$session(). If the increment did
  // not join that session, an aborted save would burn its number.
  const Shop = fakeShopModel({ shopA: 0 });
  const session = { id: 'txn-1' };

  await nextQuoteNumber('shopA', { ShopModel: Shop, session, now: SEP_2026 });

  assert.equal(Shop.calls[0].options.session, session);
});

test('passes no session when the caller has none', async () => {
  const Shop = fakeShopModel({ shopA: 0 });
  await nextQuoteNumber('shopA', { ShopModel: Shop, now: SEP_2026 });
  assert.equal(Shop.calls[0].options.session, null);
});

test('advances the counter by exactly one', async () => {
  const Shop = fakeShopModel({ shopA: 0 });
  await nextQuoteNumber('shopA', { ShopModel: Shop, now: SEP_2026 });
  assert.deepEqual(Shop.calls[0].update, { $inc: { quoteNumberSeq: 1 } });
});

test('throws a named error when the shop does not exist', async () => {
  const Shop = fakeShopModel({ shopA: 0 });
  await assert.rejects(
    nextQuoteNumber('missing', { ShopModel: Shop, now: SEP_2026 }),
    /shop missing not found/,
  );
});

test('quoteNumber is not required at validation time, so the pre-save hook can assign it', async () => {
  // Mongoose runs schema validation before pre('save') middleware runs. A
  // required quoteNumber would reject every new quotation before the hook
  // that assigns it ever executes — the exact bug this test guards against.
  // Mirrors Sale.invoiceNumber, which is not required for the same reason.
  const doc = new Quotation({
    shop: new mongoose.Types.ObjectId(),
    customer: new mongoose.Types.ObjectId(),
    customerSnapshot: { name: 'Jane' },
    items: [{ name: 'Haircut', quantity: 1, unitPrice: 300, subtotal: 300 }],
    subtotal: 300,
    total: 300,
    validUntil: new Date(),
    createdBy: new mongoose.Types.ObjectId(),
    createdByName: 'Owner',
  });

  await assert.doesNotReject(doc.validate());
});
