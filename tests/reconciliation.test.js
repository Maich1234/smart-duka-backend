import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Shift from '../src/models/Shift.js';
import Sale from '../src/models/Sale.js';
import Expense from '../src/models/Expense.js';
import Purchase from '../src/models/Purchase.js';
import User from '../src/models/User.js';
import { resolveRange } from '../src/utils/dateRanges.js';
import {
  getCashierReconciliation,
  getMonthlyFinancialReconciliation,
} from '../src/services/reconciliationService.js';

// Same convention as tests/books.test.js: fake the model statics rather than
// touching a real database.
const mockAggregate = (model, resultsInOrder) => {
  let call = 0;
  mock.method(model, 'aggregate', async () => resultsInOrder[call++] ?? []);
};

// reconciliationService wraps shopId/staffId in `new mongoose.Types.ObjectId`
// (matching purchaseSummaryService's convention), so fixtures need real
// ObjectId-shaped hex strings, not arbitrary labels.
const SHOP_ID = '507f1f77bcf86cd799439011';
const STAFF_1 = '507f1f77bcf86cd799439012';
const STAFF_2 = '507f1f77bcf86cd799439013';

function mockUserFind(rows) {
  const chain = { select: () => chain, lean: async () => rows };
  mock.method(User, 'find', () => chain);
}

beforeEach(() => mock.restoreAll());

// ── resolveRange ─────────────────────────────────────────────────────────

test('resolveRange: day defaults to the reference date\'s UTC day window', () => {
  const { start, end } = resolveRange({ period: 'day', date: '2026-08-15T18:30:00.000Z' });
  assert.equal(start.toISOString(), '2026-08-15T00:00:00.000Z');
  assert.equal(end.toISOString(), '2026-08-16T00:00:00.000Z');
});

test('resolveRange: week starts on Monday', () => {
  // 2026-08-15 is a Saturday.
  const { start, end } = resolveRange({ period: 'week', date: '2026-08-15T00:00:00.000Z' });
  assert.equal(start.toISOString(), '2026-08-10T00:00:00.000Z'); // Monday
  assert.equal(end.toISOString(), '2026-08-17T00:00:00.000Z');
});

test('resolveRange: month is the calendar month', () => {
  const { start, end } = resolveRange({ period: 'month', date: '2026-02-10T00:00:00.000Z' });
  assert.equal(start.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(end.toISOString(), '2026-03-01T00:00:00.000Z');
});

test('resolveRange: explicit startDate/endDate is inclusive of the end day', () => {
  const { start, end } = resolveRange({ startDate: '2026-07-01', endDate: '2026-07-31' });
  assert.equal(start.toISOString(), '2026-07-01T00:00:00.000Z');
  assert.equal(end.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('resolveRange: rejects a one-sided explicit range with a 400', () => {
  assert.throws(() => resolveRange({ startDate: '2026-07-01' }), (err) => err.status === 400);
});

// ── getCashierReconciliation ─────────────────────────────────────────────

test('getCashierReconciliation: rounds rolled-up totals and attaches staff names', async () => {
  mockAggregate(Shift, [
    [
      {
        _id: STAFF_1,
        shiftsCount: 2,
        salesCount: 10,
        grossSales: 1000.005,
        discounts: 10,
        cashSales: 600.001,
        mpesaSales: 300,
        cardSales: 100,
        refundsCount: 1,
        refundsTotal: 50,
        voidsCount: 1,
        voidsTotal: 20,
        cashExpensesTotal: 30,
        openingFloatTotal: 1000,
        expectedCashTotal: 1570,
        actualCashTotal: 1565,
        cashDiscrepancyTotal: -5,
      },
    ],
    [], // no active/unclosed shifts
  ]);
  mockUserFind([{ _id: STAFF_1, name: 'Amina' }]);

  const { cashiers } = await getCashierReconciliation({
    shopId: SHOP_ID,
    start: new Date('2026-08-01T00:00:00.000Z'),
    end: new Date('2026-08-08T00:00:00.000Z'),
  });

  assert.equal(cashiers.length, 1);
  assert.equal(cashiers[0].staffName, 'Amina');
  assert.equal(cashiers[0].grossSales, 1000.01); // rounded to 2dp
  assert.equal(cashiers[0].unclosedCount, 0);
  assert.equal(cashiers[0].cashDiscrepancyTotal, -5);
});

test('getCashierReconciliation: a staff member with only an open shift still appears, zeroed', async () => {
  mockAggregate(Shift, [
    [], // nothing closed in range
    [{ _id: STAFF_2, unclosedCount: 1 }],
  ]);
  mockUserFind([{ _id: STAFF_2, name: 'Brian' }]);

  const { cashiers } = await getCashierReconciliation({
    shopId: SHOP_ID,
    start: new Date('2026-08-01T00:00:00.000Z'),
    end: new Date('2026-08-08T00:00:00.000Z'),
  });

  assert.equal(cashiers.length, 1);
  assert.equal(cashiers[0].staffName, 'Brian');
  assert.equal(cashiers[0].unclosedCount, 1);
  assert.equal(cashiers[0].grossSales, 0);
  assert.equal(cashiers[0].shiftsCount, 0);
});

// ── getMonthlyFinancialReconciliation ────────────────────────────────────

test('getMonthlyFinancialReconciliation: nets revenue against expenses and purchases', async () => {
  mockAggregate(Sale, [[{ total: 50000, count: 120 }]]);
  mockAggregate(Expense, [
    [{ total: 8000 }], // expense total
    [ // by category
      { _id: 'rent', total: 5000 },
      { _id: 'utilities', total: 3000 },
    ],
  ]);
  mockAggregate(Purchase, [[{ total: 20000, count: 15 }]]);

  const result = await getMonthlyFinancialReconciliation({
    shopId: SHOP_ID,
    start: new Date('2026-07-01T00:00:00.000Z'),
    end: new Date('2026-08-01T00:00:00.000Z'),
  });

  assert.equal(result.revenue, 50000);
  assert.equal(result.expenses, 8000);
  assert.equal(result.purchases, 20000);
  assert.equal(result.netCashPosition, 22000);
  assert.deepEqual(result.expensesByCategory, [
    { category: 'rent', total: 5000 },
    { category: 'utilities', total: 3000 },
  ]);
});

test('getMonthlyFinancialReconciliation: empty range nets to zero, not NaN', async () => {
  mockAggregate(Sale, [[]]);
  mockAggregate(Expense, [[], []]);
  mockAggregate(Purchase, [[]]);

  const result = await getMonthlyFinancialReconciliation({
    shopId: SHOP_ID,
    start: new Date('2026-07-01T00:00:00.000Z'),
    end: new Date('2026-08-01T00:00:00.000Z'),
  });

  assert.equal(result.revenue, 0);
  assert.equal(result.expenses, 0);
  assert.equal(result.purchases, 0);
  assert.equal(result.netCashPosition, 0);
});
