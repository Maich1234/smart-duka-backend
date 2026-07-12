import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeShiftSummary } from '../src/services/shiftService.js';

const sale = (overrides = {}) => ({
  totalAmount: 100,
  paymentMethod: 'cash',
  status: 'completed',
  items: [],
  ...overrides,
});

test('empty shift: expected cash equals opening float', () => {
  const s = computeShiftSummary({ openingFloat: 500, closingCount: 500, sales: [] });
  assert.equal(s.salesCount, 0);
  assert.equal(s.grossSales, 0);
  assert.equal(s.expectedCash, 500);
  assert.equal(s.cashDiscrepancy, 0);
});

test('splits totals and counts by payment method', () => {
  const s = computeShiftSummary({
    openingFloat: 0,
    sales: [
      sale({ totalAmount: 100, paymentMethod: 'cash' }),
      sale({ totalAmount: 250, paymentMethod: 'mpesa' }),
      sale({ totalAmount: 250, paymentMethod: 'mpesa' }),
      sale({ totalAmount: 400, paymentMethod: 'card' }),
    ],
  });
  assert.equal(s.salesCount, 4);
  assert.equal(s.grossSales, 1000);
  assert.deepEqual(s.byMethod.cash, { count: 1, total: 100 });
  assert.deepEqual(s.byMethod.mpesa, { count: 2, total: 500 });
  assert.deepEqual(s.byMethod.card, { count: 1, total: 400 });
  // Only cash lands in the drawer.
  assert.equal(s.expectedCash, 100);
});

test('voided sales are excluded from revenue but counted', () => {
  const s = computeShiftSummary({
    openingFloat: 0,
    sales: [
      sale({ totalAmount: 100 }),
      sale({ totalAmount: 300, status: 'voided' }),
    ],
  });
  assert.equal(s.salesCount, 1);
  assert.equal(s.grossSales, 100);
  assert.deepEqual(s.voids, { count: 1, total: 300 });
  assert.equal(s.expectedCash, 100);
});

test('cash refund reduces expected cash; the sale still counts as taken', () => {
  const s = computeShiftSummary({
    openingFloat: 1000,
    closingCount: 1050,
    sales: [
      sale({ totalAmount: 200 }),
      sale({
        totalAmount: 150,
        status: 'refunded',
        refund: { amount: 150, method: 'cash' },
      }),
    ],
  });
  // Drawer took 200 + 150, then handed 150 back.
  assert.equal(s.expectedCash, 1000 + 350 - 150);
  assert.equal(s.cashDiscrepancy, 1050 - 1200);
  assert.deepEqual(s.refunds, { count: 1, total: 150, cashTotal: 150 });
});

test('m-pesa refund does not touch the cash drawer', () => {
  const s = computeShiftSummary({
    openingFloat: 0,
    sales: [
      sale({
        totalAmount: 500,
        paymentMethod: 'mpesa',
        status: 'refunded',
        refund: { amount: 500, method: 'mpesa' },
      }),
    ],
  });
  assert.equal(s.expectedCash, 0);
  assert.equal(s.refunds.cashTotal, 0);
  assert.equal(s.refunds.total, 500);
});

test('refund without explicit amount falls back to the sale total', () => {
  const s = computeShiftSummary({
    sales: [sale({ totalAmount: 320, status: 'refunded', refund: { method: 'cash' } })],
  });
  assert.equal(s.refunds.total, 320);
  assert.equal(s.refunds.cashTotal, 320);
});

test('cash expenses come out of the drawer', () => {
  const s = computeShiftSummary({
    openingFloat: 500,
    closingCount: 480,
    sales: [sale({ totalAmount: 100 })],
    cashExpenses: [{ amount: 80 }, { amount: 40 }],
  });
  assert.deepEqual(s.cashExpenses, { count: 2, total: 120 });
  assert.equal(s.expectedCash, 500 + 100 - 120);
  assert.equal(s.cashDiscrepancy, 0);
});

test('sums item-level discounts', () => {
  const s = computeShiftSummary({
    sales: [
      sale({ items: [{ discountAmount: 15 }, { discountAmount: 5 }] }),
      sale({ items: [{}] }),
    ],
  });
  assert.equal(s.discounts, 20);
});

test('no closing count means no discrepancy verdict', () => {
  const s = computeShiftSummary({ openingFloat: 100, sales: [] });
  assert.equal(s.cashDiscrepancy, null);
});

test('duration is whole minutes between start and end', () => {
  const s = computeShiftSummary({
    sales: [],
    startedAt: new Date('2026-07-10T08:00:00Z'),
    endedAt: new Date('2026-07-10T16:30:30Z'),
  });
  assert.equal(s.durationMinutes, 511);
});
