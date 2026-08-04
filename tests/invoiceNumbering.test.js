import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextInvoiceNumber, formatInvoiceNumber } from '../src/services/invoiceNumberService.js';

// A stand-in for the Shop model that models findByIdAndUpdate's atomicity:
// the increment and the read of the new value happen together, so interleaved
// callers cannot observe the same counter. That is the property the old
// countDocuments() approach lacked.
const fakeShopModel = (seeds = { s1: 0 }) => {
  const counters = { ...seeds };
  const calls = [];

  return {
    calls,
    counters,
    async findByIdAndUpdate(id, update, options) {
      calls.push({ id, update, options });
      if (!(id in counters)) return null;
      counters[id] += update.$inc.invoiceSeq;
      return { invoiceSeq: counters[id] };
    },
  };
};

const JAN_2026 = new Date('2026-01-15T10:00:00Z');
const AUG_2026 = new Date('2026-08-03T10:00:00Z');

test('formats as INV-YYMM-NNNNN with zero padding', () => {
  assert.equal(formatInvoiceNumber(1, AUG_2026), 'INV-2608-00001');
  assert.equal(formatInvoiceNumber(42, AUG_2026), 'INV-2608-00042');
  assert.equal(formatInvoiceNumber(99999, AUG_2026), 'INV-2608-99999');
});

test('pads the month, so January is 01 not 1', () => {
  assert.equal(formatInvoiceNumber(1, JAN_2026), 'INV-2601-00001');
});

test('numbers beyond five digits are not truncated', () => {
  // padStart only ever pads. A shop past 99,999 sales keeps a valid, unique
  // number rather than silently wrapping back into a used one.
  assert.equal(formatInvoiceNumber(100000, AUG_2026), 'INV-2608-100000');
});

test('two shops each start at 00001 without colliding', async () => {
  // THE ORIGINAL BUG. Both shops legitimately want INV-2608-00001; under the
  // old collection-wide unique index the second shop's sale was rejected
  // outright. Per-shop counters make the pair correct, and the compound
  // { shop, invoiceNumber } index makes it storable.
  const Shop = fakeShopModel({ shopA: 0, shopB: 0 });

  const a = await nextInvoiceNumber('shopA', { ShopModel: Shop, now: AUG_2026 });
  const b = await nextInvoiceNumber('shopB', { ShopModel: Shop, now: AUG_2026 });

  assert.equal(a, 'INV-2608-00001');
  assert.equal(b, 'INV-2608-00001');
});

test('one shop increments across sequential sales', async () => {
  const Shop = fakeShopModel({ shopA: 0 });

  const first = await nextInvoiceNumber('shopA', { ShopModel: Shop, now: AUG_2026 });
  const second = await nextInvoiceNumber('shopA', { ShopModel: Shop, now: AUG_2026 });
  const third = await nextInvoiceNumber('shopA', { ShopModel: Shop, now: AUG_2026 });

  assert.deepEqual(
    [first, second, third],
    ['INV-2608-00001', 'INV-2608-00002', 'INV-2608-00003'],
  );
});

test('concurrent sales in one shop never share a number', async () => {
  // The second original bug: countDocuments() was a read, so N concurrent
  // sales all saw the same count and all built the same number.
  const Shop = fakeShopModel({ shopA: 0 });

  const numbers = await Promise.all(
    Array.from({ length: 25 }, () =>
      nextInvoiceNumber('shopA', { ShopModel: Shop, now: AUG_2026 })),
  );

  assert.equal(new Set(numbers).size, 25, 'every concurrent sale must get a distinct number');
  assert.equal(Shop.counters.shopA, 25);
});

test('continues from a seeded counter rather than restarting', async () => {
  // What scripts/fixInvoiceNumbering.mjs sets up for an existing database.
  const Shop = fakeShopModel({ shopA: 137 });
  const next = await nextInvoiceNumber('shopA', { ShopModel: Shop, now: AUG_2026 });
  assert.equal(next, 'INV-2608-00138');
});

test('the month prefix changes but the counter does not reset', async () => {
  // Numbering is lifetime-per-shop; YYMM is display only. This matches the old
  // behaviour, where countDocuments() counted every sale ever made.
  const Shop = fakeShopModel({ shopA: 0 });

  const january = await nextInvoiceNumber('shopA', { ShopModel: Shop, now: JAN_2026 });
  const august = await nextInvoiceNumber('shopA', { ShopModel: Shop, now: AUG_2026 });

  assert.equal(january, 'INV-2601-00001');
  assert.equal(august, 'INV-2608-00002');
});

test('joins the caller transaction when a session is given', async () => {
  // saleController creates sales inside withTransaction. If the increment did
  // not join that session, an aborted sale would burn its number — and worse,
  // the counter read would not see uncommitted siblings.
  const Shop = fakeShopModel({ shopA: 0 });
  const session = { id: 'txn-1' };

  await nextInvoiceNumber('shopA', { ShopModel: Shop, session, now: AUG_2026 });

  assert.equal(Shop.calls[0].options.session, session);
});

test('passes no session when the caller has none', async () => {
  const Shop = fakeShopModel({ shopA: 0 });
  await nextInvoiceNumber('shopA', { ShopModel: Shop, now: AUG_2026 });
  assert.equal(Shop.calls[0].options.session, null);
});

test('advances the counter by exactly one', async () => {
  const Shop = fakeShopModel({ shopA: 0 });
  await nextInvoiceNumber('shopA', { ShopModel: Shop, now: AUG_2026 });
  assert.deepEqual(Shop.calls[0].update, { $inc: { invoiceSeq: 1 } });
});

test('throws a named error when the shop does not exist', async () => {
  const Shop = fakeShopModel({ shopA: 0 });
  await assert.rejects(
    nextInvoiceNumber('missing', { ShopModel: Shop, now: AUG_2026 }),
    /shop missing not found/,
  );
});
