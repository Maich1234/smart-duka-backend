import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Sale from '../src/models/Sale.js';
import Expense from '../src/models/Expense.js';
import Purchase from '../src/models/Purchase.js';
import { buildCashbook } from '../src/services/books/cashbookService.js';
import { buildProfitLoss } from '../src/services/books/profitLossService.js';
import {
  buildSalesRegister,
  buildExpenseRegister,
  buildPurchaseRegister,
} from '../src/services/books/registerServices.js';
import { periodLabel } from '../src/services/books/bookDocument.js';

/**
 * These check the figures, not the formatting. A book that renders beautifully
 * and reports the wrong profit is worse than no book, and the rules about what
 * counts (credit purchases, voids, refund timing) are exactly where a
 * plausible-looking mistake hides.
 */

const SHOP = { _id: 'shop-1', name: 'Test Duka', currency: 'KES', purchasingEnabled: true };
const PERIOD = { from: '2026-07-01', to: '2026-07-31' };
const d = (day, hour = 9) => new Date(Date.UTC(2026, 6, day, hour));

/** Fakes the `.find().select().sort().lean()` / `.populate()` chain. */
function mockFind(model, rows) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    populate: () => chain,
    lean: async () => rows,
  };
  mock.method(model, 'find', () => chain);
}

const mockAggregate = (model, resultsInOrder) => {
  let call = 0;
  mock.method(model, 'aggregate', async () => resultsInOrder[call++] ?? []);
};

const rowsOf = (doc) => doc.sections.flatMap((s) => s.rows);

beforeEach(() => mock.restoreAll());

// ── Cashbook ───────────────────────────────────────────────────────────────

test('cashbook: excludes credit purchases — no cash moved', async () => {
  mockFind(Sale, []);
  mockFind(Expense, []);
  // The service filters on paymentMethod ≠ credit in the query, so a correct
  // implementation never receives one. Asserting the query proves the filter.
  let queried;
  mock.method(Purchase, 'find', (q) => {
    queried = q;
    const chain = { select: () => chain, sort: () => chain, lean: async () => [] };
    return chain;
  });

  await buildCashbook({ shop: SHOP, ownerName: 'Jane', ...PERIOD });

  assert.deepEqual(queried.paymentMethod, { $ne: 'credit' });
  assert.deepEqual(queried.status, { $ne: 'cancelled' });
});

test('cashbook: voided sales never appear', async () => {
  let queried;
  mock.method(Sale, 'find', (q) => {
    queried = q;
    const chain = { select: () => chain, sort: () => chain, lean: async () => [] };
    return chain;
  });
  mockFind(Expense, []);
  mockFind(Purchase, []);

  await buildCashbook({ shop: SHOP, ownerName: 'Jane', ...PERIOD });

  assert.ok(!queried.status.$in.includes('voided'), 'voided must not be selected');
  assert.ok(queried.status.$in.includes('refund_pending'), 'money is still with the shop');
});

test('cashbook: running balance, and a refund lands on its completion date', async () => {
  mockFind(Sale, [
    { invoiceNumber: 'INV-1', totalAmount: 1000, paymentMethod: 'cash', createdAt: d(1), status: 'completed' },
    {
      invoiceNumber: 'INV-2', totalAmount: 400, paymentMethod: 'mpesa', createdAt: d(2), status: 'refunded',
      refund: { amount: 400, method: 'mpesa', completedAt: d(5), reason: 'Wrong size' },
    },
  ]);
  mockFind(Expense, [{ category: 'rent', description: 'July rent', amount: 300, paymentMethod: 'cash', date: d(3) }]);
  mockFind(Purchase, [{ supplierName: 'Wholesaler', grandTotal: 200, paymentMethod: 'cash', purchaseDate: d(4) }]);

  const doc = await buildCashbook({ shop: SHOP, ownerName: 'Jane', ...PERIOD });
  const rows = doc.sections[0].rows;

  // 1000 in, 400 in, 300 out, 200 out, 400 out (the refund, on the 5th)
  assert.deepEqual(rows.map((r) => r.balance), [1000, 1400, 1100, 900, 500]);
  assert.equal(doc.totals.moneyIn, 1400);
  assert.equal(doc.totals.moneyOut, 900);
  assert.equal(doc.totals.balance, 500);

  const refundRow = rows.find((r) => String(r.reference).startsWith('Refund'));
  assert.equal(refundRow.moneyOut, 400);
  assert.equal(refundRow.description, 'Wrong size');
});

test('cashbook: a refund completed outside the period is not counted in it', async () => {
  mockFind(Sale, [{
    invoiceNumber: 'INV-9', totalAmount: 500, paymentMethod: 'cash', createdAt: d(20), status: 'refunded',
    refund: { amount: 500, method: 'cash', completedAt: new Date(Date.UTC(2026, 7, 4)) }, // August
  }]);
  mockFind(Expense, []);
  mockFind(Purchase, []);

  const doc = await buildCashbook({ shop: SHOP, ownerName: 'Jane', ...PERIOD });

  assert.equal(doc.totals.moneyOut, 0, 'August refund belongs to August');
  assert.equal(doc.totals.moneyIn, 500);
});

test('cashbook: splits by payment method', async () => {
  mockFind(Sale, [
    { invoiceNumber: 'A', totalAmount: 100, paymentMethod: 'cash', createdAt: d(1), status: 'completed' },
    { invoiceNumber: 'B', totalAmount: 250, paymentMethod: 'mpesa', createdAt: d(2), status: 'completed' },
    { invoiceNumber: 'C', totalAmount: 70, paymentMethod: 'airtel_money', createdAt: d(3), status: 'completed' },
  ]);
  mockFind(Expense, []);
  mockFind(Purchase, []);

  const doc = await buildCashbook({ shop: SHOP, ownerName: 'Jane', ...PERIOD });
  const split = doc.sections.find((s) => s.label === 'By payment method');

  const cash = split.rows.find((r) => r.reference === 'Cash');
  const mpesa = split.rows.find((r) => r.reference === 'M-Pesa');
  assert.equal(cash.moneyIn, 100);
  // Airtel is a mobile-money pot, grouped with M-Pesa rather than "Other".
  assert.equal(mpesa.moneyIn, 320);
});

// ── Profit & Loss ──────────────────────────────────────────────────────────

test('profit & loss: gross profit is revenue minus snapshotted cost', async () => {
  mockAggregate(Sale, [
    [{ revenue: 10000, discounts: 0, cogs: 6000, estimatedLines: 0, missingCost: 0, commission: 0 }],
    [], // no refunds
  ]);
  mockAggregate(Expense, [[{ _id: 'rent', total: 1500, count: 1 }, { _id: 'transport', total: 500, count: 3 }]]);

  const doc = await buildProfitLoss({ shop: SHOP, ownerName: 'Jane', ...PERIOD });

  assert.equal(doc.totals.revenue, 10000);
  assert.equal(doc.totals.costOfGoodsSold, 6000);
  assert.equal(doc.totals.grossProfit, 4000);
  assert.equal(doc.totals.operatingExpenses, 2000);
  assert.equal(doc.totals.netProfit, 2000);
  assert.equal(doc.meta.estimated, false);
});

test('profit & loss: refunds reduce revenue, commission is an operating cost', async () => {
  mockAggregate(Sale, [
    [{ revenue: 5000, discounts: 0, cogs: 2000, estimatedLines: 0, missingCost: 0, commission: 300 }],
    [{ total: 500, count: 2 }],
  ]);
  mockAggregate(Expense, [[{ _id: 'salaries', total: 1000, count: 1 }]]);

  const doc = await buildProfitLoss({ shop: SHOP, ownerName: 'Jane', ...PERIOD });

  assert.equal(doc.totals.revenue, 4500, 'net of refunds');
  assert.equal(doc.totals.grossProfit, 2500);
  assert.equal(doc.totals.operatingExpenses, 1300, 'expenses plus commission');
  assert.equal(doc.totals.netProfit, 1200);
});

test('profit & loss: flags estimated cost and says gross profit is overstated', async () => {
  mockAggregate(Sale, [
    [{ revenue: 1000, discounts: 0, cogs: 400, estimatedLines: 3, missingCost: 2, commission: 0 }],
    [],
  ]);
  mockAggregate(Expense, [[]]);

  const doc = await buildProfitLoss({ shop: SHOP, ownerName: 'Jane', ...PERIOD });

  assert.equal(doc.meta.estimated, true);
  assert.ok(doc.footnotes.some((n) => n.includes('reconstructed for 3 sale lines')));
  assert.ok(doc.footnotes.some((n) => n.includes('overstated')));
  assert.ok(doc.footnotes.some((n) => n.includes('not an IFRS')), 'must not read as an audited statement');
});

// ── Registers ──────────────────────────────────────────────────────────────

test('sales register: voided and refunded rows show but do not count', async () => {
  mockFind(Sale, [
    { invoiceNumber: 'A', totalAmount: 100, createdAt: d(1), status: 'completed', items: [{ quantity: 2 }] },
    { invoiceNumber: 'B', totalAmount: 999, createdAt: d(2), status: 'voided', items: [{ quantity: 1 }] },
    { invoiceNumber: 'C', totalAmount: 555, createdAt: d(3), status: 'refunded', items: [{ quantity: 1 }] },
    { invoiceNumber: 'D', totalAmount: 50, createdAt: d(4), status: 'refund_pending', items: [{ quantity: 1 }] },
  ]);

  const doc = await buildSalesRegister({ shop: SHOP, ownerName: 'Jane', ...PERIOD });
  const rows = rowsOf(doc);

  assert.equal(rows.length, 4, 'all four are listed');
  assert.equal(doc.totals.amount, 150, 'only completed + refund_pending count');
  assert.equal(doc.totals.sales, 2);
  assert.equal(rows.find((r) => r.invoice === 'B').amount, '', 'voided shows blank, not zero');
  assert.equal(rows.find((r) => r.invoice === 'B').status, 'Voided');
});

test('expense register: groups by category, largest first', async () => {
  mockFind(Expense, [
    { category: 'rent', description: 'July', amount: 5000, paymentMethod: 'bank', date: d(1) },
    { category: 'transport', description: 'Boda', amount: 200, paymentMethod: 'cash', date: d(2) },
    { category: 'transport', description: 'Matatu', amount: 300, paymentMethod: 'cash', date: d(3) },
  ]);

  const doc = await buildExpenseRegister({ shop: SHOP, ownerName: 'Jane', ...PERIOD });

  assert.match(doc.sections[0].label, /^Rent/);
  assert.match(doc.sections[1].label, /^Transport — 2 items/);
  assert.equal(doc.sections[1].subtotals.amount, 500);
  assert.equal(doc.totals.amount, 5500);
});

test('purchase register: cancelled excluded from total, pending approval included', async () => {
  mockFind(Purchase, [
    { supplierName: 'A', items: [{}], productsTotal: 100, additionalCostsTotal: 20, grandTotal: 120, purchaseDate: d(1), status: 'completed' },
    { supplierName: 'B', items: [{}], productsTotal: 900, additionalCostsTotal: 0, grandTotal: 900, purchaseDate: d(2), status: 'cancelled' },
    { supplierName: 'C', items: [{}], productsTotal: 80, additionalCostsTotal: 0, grandTotal: 80, purchaseDate: d(3), status: 'pending_approval' },
  ]);

  const doc = await buildPurchaseRegister({ shop: SHOP, ownerName: 'Jane', ...PERIOD });
  const rows = rowsOf(doc);

  assert.equal(rows.length, 3);
  assert.equal(doc.totals.amount, 200, 'cancelled excluded, pending included');
  assert.equal(rows.find((r) => r.supplier === 'B').amount, '');
  assert.equal(rows.find((r) => r.supplier === 'C').status, 'pending approval');
});

// ── Shared document shape ──────────────────────────────────────────────────

test('period labels read naturally', () => {
  assert.equal(periodLabel('2026-07-01', '2026-07-31'), 'July 2026');
  assert.equal(periodLabel('2026-01-01', '2026-12-31'), '2026');
  assert.equal(periodLabel('2026-07-01', '2026-07-15'), '1 Jul – 15 Jul 2026');
  assert.equal(periodLabel('2025-12-20', '2026-01-10'), '20 Dec 2025 – 10 Jan 2026');
});

test('every book carries the shop, period and currency for a detached file', async () => {
  mockFind(Sale, []);
  mockFind(Expense, []);
  mockFind(Purchase, []);

  const doc = await buildCashbook({ shop: SHOP, ownerName: 'Jane Njeri', ...PERIOD });

  assert.equal(doc.shop.name, 'Test Duka');
  assert.equal(doc.shop.currency, 'KES');
  assert.equal(doc.shop.ownerName, 'Jane Njeri');
  assert.equal(doc.period.label, 'July 2026');
  assert.ok(doc.meta.generatedAt);
  assert.ok(doc.footnotes.length > 0, 'a financial document must state its assumptions');
});
