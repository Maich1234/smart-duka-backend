import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Customer from '../src/models/Customer.js';
import CreditTransaction from '../src/models/CreditTransaction.js';
import {
  CreditRejection,
  assertProductsCreditEligible,
  bookDebt,
  recordRepayment,
  recomputeCustomerCredit,
  reverseDebt,
  reverseRepayment,
  summariseAccount,
} from '../src/services/creditService.js';
import { CREDIT_TX_TYPES } from '../src/constants/credit.js';

/**
 * The ledger's behaviour: what a repayment does to which debt, what a
 * correction puts back, and what the guards refuse.
 *
 * Models are mocked rather than run against a live mongod — the same approach
 * reconciliationController.test.js takes — because what is being checked here
 * is the logic, and because the transactional paths need a replica set that CI
 * does not have. The *shape* of the guard filters is asserted explicitly, since
 * those filters are the whole concurrency story and a silent edit to one would
 * otherwise pass every test in this file.
 */

const SHOP = { _id: 'shop1', currency: 'KES' };
const USER = { _id: 'user1', name: 'Amina', role: 'staff', permissions: ['make_credit_sale'] };
const SETTINGS = {
  enabled: true,
  defaultCreditLimit: 3000,
  defaultCollectionPeriodDays: 7,
  productPolicy: 'ALL_PRODUCTS',
  overduePolicy: 'BLOCK',
};

/** A stand-in debt row with just enough of a Mongoose document's surface. */
const makeDebt = ({ id, amount, outstanding, dueAt, status = 'outstanding', type = CREDIT_TX_TYPES.SALE }) => ({
  _id: id,
  type,
  amount,
  outstanding,
  dueAt: new Date(dueAt),
  status,
  overdueAt: null,
  reversedBy: null,
  customer: 'cust1',
  saved: 0,
  async save() { this.saved += 1; return this; },
});

/** Captures what findOneAndUpdate was called with, and what it returns. */
function stubCustomerUpdate(result) {
  const calls = [];
  mock.method(Customer, 'findOneAndUpdate', async (filter, update, options) => {
    calls.push({ filter, update, options });
    return typeof result === 'function' ? result(calls.length) : result;
  });
  return calls;
}

/**
 * `exists()` returns a Query in Mongoose, so the stub has to be chainable
 * through `.session()` the way the service actually calls it — an async
 * function here would pass the call and fail the chain.
 */
function stubExists(Model, value) {
  mock.method(Model, 'exists', () => ({ session: async () => value }));
}

/** Chainable find() stub ending in .session() or .lean(). */
function stubFind(Model, rows) {
  const chain = {
    select() { return this; },
    sort() { return this; },
    session() { return this; },
    lean: async () => rows,
    then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
  };
  mock.method(Model, 'find', () => chain);
  return chain;
}

beforeEach(() => mock.restoreAll());

// ── Product eligibility ─────────────────────────────────────────────────────

test('ALL_PRODUCTS: nothing is ever refused on eligibility grounds', () => {
  const products = [{ name: 'Sugar', creditEligible: false }, { name: 'Soap' }];
  assert.doesNotThrow(() => assertProductsCreditEligible(products, { productPolicy: 'ALL_PRODUCTS' }));
});

test('SELECTED_PRODUCTS: an unflagged product is refused, and the message names it', () => {
  const products = [
    { name: 'Sugar', creditEligible: true },
    { name: 'Airtime', creditEligible: false },
  ];
  assert.throws(
    () => assertProductsCreditEligible(products, { productPolicy: 'SELECTED_PRODUCTS' }),
    (err) => {
      assert.ok(err instanceof CreditRejection);
      assert.equal(err.code, 'PRODUCT_NOT_CREDIT_ELIGIBLE');
      // Naming it is the point: "some item in your cart" sends a cashier
      // hunting through twenty lines at a counter with a queue behind them.
      assert.match(err.message, /Airtime/);
      assert.deepEqual(err.details.products, ['Airtime']);
      return true;
    },
  );
});

test('SELECTED_PRODUCTS fails closed: a product that never opted in is ineligible', () => {
  // The default is false, so switching policy blocks everything until the
  // owner picks. A silently-permissive default would look restrictive while
  // permitting the entire catalogue.
  assert.throws(
    () => assertProductsCreditEligible([{ name: 'Bread' }], { productPolicy: 'SELECTED_PRODUCTS' }),
    /Bread/,
  );
});

test('SELECTED_PRODUCTS: many ineligible products are summarised, not dumped', () => {
  const products = ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, creditEligible: false }));
  assert.throws(
    () => assertProductsCreditEligible(products, { productPolicy: 'SELECTED_PRODUCTS' }),
    /A, B, C and 2 more/,
  );
});

// ── Booking a debt ──────────────────────────────────────────────────────────

test('bookDebt: the limit guard reads the limit from the document, not from the caller', async () => {
  const calls = stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 2000 } });
  mock.method(CreditTransaction, 'create', async ([doc]) => [{ ...doc, _id: 'tx1' }]);
  stubFind(CreditTransaction, []);
  stubExists(CreditTransaction, null);

  await bookDebt({
    shop: SHOP, customerId: 'cust1', amount: 500, settings: SETTINGS, user: USER, session: null,
  });

  const { filter } = calls[0];
  // $ifNull against the shop default, evaluated inside the update — an owner
  // lowering a limit concurrently still wins, which a value passed in from a
  // prior read could never achieve.
  assert.ok(filter.$expr, 'the increase must be conditional, not a bare $inc');
  const [sum, ceiling] = filter.$expr.$lte;
  assert.deepEqual(sum.$add, ['$credit.outstanding', 500]);
  assert.equal(ceiling.$add[0].$ifNull[0], '$credit.limit');
  assert.equal(ceiling.$add[0].$ifNull[1], SETTINGS.defaultCreditLimit);
  // And the tenant, the archive flag and the block flag are all part of the
  // same atomic condition rather than earlier reads.
  assert.equal(filter.shop, 'shop1');
  assert.equal(filter.isActive, true);
  assert.deepEqual(filter['credit.blocked'], { $ne: true });
});

test('bookDebt: the BLOCK policy bars an already-matured debt at the instant of sale', async () => {
  const calls = stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 100 } });
  mock.method(CreditTransaction, 'create', async ([doc]) => [{ ...doc, _id: 'tx1' }]);
  stubFind(CreditTransaction, []);
  stubExists(CreditTransaction, null);

  const now = new Date('2026-09-14T10:00:00');
  await bookDebt({ shop: SHOP, customerId: 'cust1', amount: 100, settings: SETTINGS, user: USER, session: null, now });

  // Checked against oldestDueAt, which every write maintains synchronously —
  // not against the stored overdueAmount, which only the nightly sweep
  // refreshes. A debt maturing at midnight must block credit at 00:00:01.
  assert.deepEqual(calls[0].filter.$or, [
    { 'credit.oldestDueAt': null },
    { 'credit.oldestDueAt': { $gt: now } },
  ]);
});

test('bookDebt: the ALLOW policy drops the overdue bar but keeps the limit', async () => {
  const calls = stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 100 } });
  mock.method(CreditTransaction, 'create', async ([doc]) => [{ ...doc, _id: 'tx1' }]);
  stubFind(CreditTransaction, []);
  stubExists(CreditTransaction, null);

  await bookDebt({
    shop: SHOP, customerId: 'cust1', amount: 100,
    settings: { ...SETTINGS, overduePolicy: 'ALLOW' }, user: USER, session: null,
  });

  assert.equal(calls[0].filter.$or, undefined, 'ALLOW must not bar an overdue customer');
  assert.ok(calls[0].filter.$expr, 'but the credit limit still applies');
});

test('bookDebt: a refused guard explains which condition failed, with the real figures', async () => {
  mock.method(Customer, 'findOneAndUpdate', async () => null);
  mock.method(Customer, 'findOne', () => ({
    session: async () => ({
      _id: 'cust1', name: 'John', isActive: true,
      credit: { blocked: false, outstanding: 2800, limit: null, oldestDueAt: null },
    }),
  }));

  await assert.rejects(
    bookDebt({ shop: SHOP, customerId: 'cust1', amount: 500, settings: SETTINGS, user: USER, session: null }),
    (err) => {
      assert.equal(err.code, 'CREDIT_LIMIT_EXCEEDED');
      // The brief's own example: the cashier is told the number, not a status.
      assert.match(err.message, /John has KES 200\.00 available/);
      assert.equal(err.details.available, 200);
      assert.equal(err.details.requested, 500);
      return true;
    },
  );
});

test('bookDebt: a blocked customer is refused by name and reason, not by limit', async () => {
  mock.method(Customer, 'findOneAndUpdate', async () => null);
  mock.method(Customer, 'findOne', () => ({
    session: async () => ({
      _id: 'cust1', name: 'Mary', isActive: true,
      credit: { blocked: true, blockedReason: 'repeated late payment', outstanding: 0, limit: 5000 },
    }),
  }));

  await assert.rejects(
    bookDebt({ shop: SHOP, customerId: 'cust1', amount: 100, settings: SETTINGS, user: USER, session: null }),
    (err) => {
      assert.equal(err.code, 'CUSTOMER_CREDIT_BLOCKED');
      assert.match(err.message, /Mary is blocked from credit: repeated late payment/);
      return true;
    },
  );
});

test('bookDebt: a customer with no limit gets a different message than one who is maxed out', async () => {
  mock.method(Customer, 'findOneAndUpdate', async () => null);
  mock.method(Customer, 'findOne', () => ({
    session: async () => ({
      _id: 'cust1', name: 'Peter', isActive: true,
      credit: { blocked: false, outstanding: 0, limit: null, oldestDueAt: null },
    }),
  }));

  await assert.rejects(
    bookDebt({
      shop: SHOP, customerId: 'cust1', amount: 100,
      settings: { ...SETTINGS, defaultCreditLimit: 0 }, user: USER, session: null,
    }),
    (err) => {
      assert.equal(err.code, 'NO_CREDIT_LIMIT');
      assert.match(err.message, /no credit limit set/);
      return true;
    },
  );
});

test('bookDebt: zero and negative amounts are refused before anything is written', async () => {
  const calls = stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 0 } });
  for (const amount of [0, -100, -0.01]) {
    await assert.rejects(
      bookDebt({ shop: SHOP, customerId: 'cust1', amount, settings: SETTINGS, user: USER, session: null }),
      (err) => err.code === 'INVALID_AMOUNT',
    );
  }
  assert.equal(calls.length, 0, 'no balance may move for an invalid amount');
});

test('bookDebt: an opening balance bypasses the limit but never the tenant scope', async () => {
  const calls = stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 9000 } });
  mock.method(CreditTransaction, 'create', async ([doc]) => [{ ...doc, _id: 'tx1' }]);
  stubFind(CreditTransaction, []);
  stubExists(CreditTransaction, null);

  await bookDebt({
    type: CREDIT_TX_TYPES.OPENING_BALANCE,
    shop: SHOP, customerId: 'cust1', amount: 9000, settings: SETTINGS, user: USER,
    session: null, enforceLimit: false,
  });

  // An owner recording money they are already owed is not extending new
  // credit; refusing would leave the shop unable to write down a real debt.
  assert.equal(calls[0].filter.$expr, undefined, 'the limit must not apply to a brought-forward debt');
  assert.equal(calls[0].filter.shop, 'shop1', 'but it is still scoped to the shop');
  assert.equal(calls[0].filter.isActive, true);
});

// ── Repayments ──────────────────────────────────────────────────────────────

test('recordRepayment: the decrement guard makes an over-payment impossible, not merely checked', async () => {
  const calls = stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 500 } });
  stubFind(CreditTransaction, []);
  mock.method(CreditTransaction, 'create', async ([doc]) => [{ ...doc, _id: 'pay1' }]);
  stubExists(CreditTransaction, { _id: 'x' });

  await recordRepayment({
    shop: SHOP, customerId: 'cust1', amount: 500, paymentMethod: 'cash',
    paymentMethodLabel: 'Cash', user: USER, session: null,
  });

  const [left, right] = calls[0].filter.$expr.$gte;
  assert.deepEqual(left.$add[0], '$credit.outstanding');
  assert.equal(right, 500);
  // Two cashiers taking the last 500 of a 500 debt at the same moment cannot
  // both match this filter.
  assert.equal(calls[0].update.$inc['credit.outstanding'], -500);
  assert.equal(calls[0].update.$inc['credit.totalRepaid'], 500);
});

test('recordRepayment: allocates oldest-due first and settles each debt it clears', async () => {
  const oldest = makeDebt({ id: 'd1', amount: 600, outstanding: 600, dueAt: '2026-09-01' });
  const middle = makeDebt({ id: 'd2', amount: 400, outstanding: 400, dueAt: '2026-09-10' });
  const newest = makeDebt({ id: 'd3', amount: 500, outstanding: 500, dueAt: '2026-09-20' });

  stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 700 } });
  stubFind(CreditTransaction, [oldest, middle, newest]);
  let created;
  mock.method(CreditTransaction, 'create', async ([doc]) => { created = doc; return [{ ...doc, _id: 'pay1' }]; });
  stubExists(CreditTransaction, { _id: 'x' });

  await recordRepayment({
    shop: SHOP, customerId: 'cust1', amount: 800, paymentMethod: 'cash',
    paymentMethodLabel: 'Cash', user: USER, session: null,
  });

  // 800 clears the 600 debt entirely and takes 200 off the next one. Paying
  // the oldest first is what both a shopkeeper and a customer assume, and it
  // is what makes aging mean anything.
  assert.equal(oldest.outstanding, 0);
  assert.equal(oldest.status, 'paid');
  assert.equal(middle.outstanding, 200);
  assert.equal(middle.status, 'outstanding');
  assert.equal(newest.outstanding, 500, 'the newest debt is untouched');
  assert.equal(newest.saved, 0, 'and is not even written');

  assert.deepEqual(created.allocations, [
    { transaction: 'd1', amount: 600 },
    { transaction: 'd2', amount: 200 },
  ]);
});

test('recordRepayment: a settled debt stops being overdue', async () => {
  const lateDebt = makeDebt({ id: 'd1', amount: 300, outstanding: 300, dueAt: '2026-08-01' });
  lateDebt.overdueAt = new Date('2026-08-02');

  stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 0 } });
  stubFind(CreditTransaction, [lateDebt]);
  mock.method(CreditTransaction, 'create', async ([doc]) => [{ ...doc, _id: 'pay1' }]);
  stubExists(CreditTransaction, { _id: 'x' });

  await recordRepayment({
    shop: SHOP, customerId: 'cust1', amount: 300, paymentMethod: 'cash',
    paymentMethodLabel: 'Cash', user: USER, session: null,
  });

  assert.equal(lateDebt.status, 'paid');
  // Clearing this is what stops a paid debt reappearing on the owner's
  // overdue list and in the nightly sweep.
  assert.equal(lateDebt.overdueAt, null);
});

test('recordRepayment: a partial payment leaves the rest open', async () => {
  const debt = makeDebt({ id: 'd1', amount: 1000, outstanding: 1000, dueAt: '2026-09-20' });
  stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 700 } });
  stubFind(CreditTransaction, [debt]);
  let created;
  mock.method(CreditTransaction, 'create', async ([doc]) => { created = doc; return [{ ...doc, _id: 'pay1' }]; });
  stubExists(CreditTransaction, { _id: 'x' });

  await recordRepayment({
    shop: SHOP, customerId: 'cust1', amount: 300, paymentMethod: 'mpesa',
    paymentMethodLabel: 'M-PESA', reference: 'QGJ7ABC123', user: USER, session: null,
  });

  assert.equal(debt.outstanding, 700);
  assert.equal(debt.status, 'outstanding');
  assert.equal(created.reference, 'QGJ7ABC123');
  assert.deepEqual(created.allocations, [{ transaction: 'd1', amount: 300 }]);
});

test('recordRepayment: paying more than is owed is refused, naming the real balance', async () => {
  mock.method(Customer, 'findOneAndUpdate', async () => null);
  mock.method(Customer, 'findOne', () => ({
    session: async () => ({ _id: 'cust1', name: 'John', credit: { outstanding: 450 } }),
  }));

  await assert.rejects(
    recordRepayment({
      shop: SHOP, customerId: 'cust1', amount: 1000, paymentMethod: 'cash',
      paymentMethodLabel: 'Cash', user: USER, session: null,
    }),
    (err) => {
      assert.equal(err.code, 'REPAYMENT_EXCEEDS_BALANCE');
      assert.match(err.message, /The balance is KES 450\.00/);
      assert.equal(err.details.outstanding, 450);
      return true;
    },
  );
});

test('recordRepayment: paying a cleared account says so rather than reporting a balance of zero', async () => {
  mock.method(Customer, 'findOneAndUpdate', async () => null);
  mock.method(Customer, 'findOne', () => ({
    session: async () => ({ _id: 'cust1', name: 'John', credit: { outstanding: 0 } }),
  }));

  await assert.rejects(
    recordRepayment({
      shop: SHOP, customerId: 'cust1', amount: 100, paymentMethod: 'cash',
      paymentMethodLabel: 'Cash', user: USER, session: null,
    }),
    (err) => {
      assert.match(err.message, /already cleared their balance/);
      return true;
    },
  );
});

test('recordRepayment: an exact payoff after float drift is accepted, not rejected by a cent', async () => {
  // 1000 paid down in twelve 83.33 slices leaves a residue below a cent. The
  // epsilon in the guard is what lets the customer actually finish paying.
  let outstanding = 1000;
  for (let i = 0; i < 12; i += 1) outstanding = Math.round((outstanding - 83.33) * 100) / 100;
  const calls = stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 0 } });
  stubFind(CreditTransaction, [makeDebt({ id: 'd1', amount: 1000, outstanding, dueAt: '2026-09-20' })]);
  mock.method(CreditTransaction, 'create', async ([doc]) => [{ ...doc, _id: 'pay1' }]);
  stubExists(CreditTransaction, { _id: 'x' });

  await recordRepayment({
    shop: SHOP, customerId: 'cust1', amount: outstanding, paymentMethod: 'cash',
    paymentMethodLabel: 'Cash', user: USER, session: null,
  });

  const [left] = calls[0].filter.$expr.$gte;
  assert.ok(left.$add[1] > 0 && left.$add[1] < 0.01, 'the guard must carry sub-cent slack');
});

// ── Corrections ─────────────────────────────────────────────────────────────

test('reverseDebt: cancelling an untouched debt writes a compensating row, never an edit', async () => {
  const debt = makeDebt({ id: 'd1', amount: 500, outstanding: 500, dueAt: '2026-09-20' });
  const calls = stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 0 } });
  stubFind(CreditTransaction, []);
  let created;
  mock.method(CreditTransaction, 'create', async ([doc]) => { created = doc; return [{ ...doc, _id: 'rev1' }]; });
  stubExists(CreditTransaction, { _id: 'x' });

  await reverseDebt({ shop: SHOP, transaction: debt, user: USER, session: null, reason: 'Sale voided' });

  assert.equal(created.type, CREDIT_TX_TYPES.SALE_REVERSAL);
  assert.equal(created.amount, 500);
  // The link back is what makes a timeline readable: the original stays,
  // with the correction beside it.
  assert.equal(created.reversalOf, 'd1');
  assert.equal(created.reason, 'Sale voided');
  assert.equal(debt.status, 'reversed');
  assert.equal(debt.outstanding, 0);
  assert.equal(debt.reversedBy, 'rev1');
  // Reversing a debt is not a repayment — it must not inflate what the
  // customer appears to have paid over their lifetime.
  assert.equal(calls[0].update.$inc['credit.totalRepaid'], undefined);
  assert.equal(calls[0].update.$inc['credit.totalExtended'], -500);
});

test('reverseDebt: a partly-repaid debt cannot simply be cancelled', async () => {
  const debt = makeDebt({ id: 'd1', amount: 500, outstanding: 200, dueAt: '2026-09-20' });
  await assert.rejects(
    reverseDebt({ shop: SHOP, transaction: debt, user: USER, session: null }),
    (err) => {
      assert.equal(err.code, 'DEBT_PARTLY_REPAID');
      // Silently cancelling it would discard the record of 300 that genuinely
      // changed hands.
      assert.match(err.message, /Reverse the repayment first/);
      return true;
    },
  );
  assert.equal(debt.status, 'outstanding', 'nothing may change on a refused reversal');
});

test('reverseDebt: an already-reversed entry cannot be reversed twice', async () => {
  const debt = makeDebt({ id: 'd1', amount: 500, outstanding: 0, dueAt: '2026-09-20', status: 'reversed' });
  await assert.rejects(
    reverseDebt({ shop: SHOP, transaction: debt, user: USER, session: null }),
    (err) => err.code === 'ALREADY_REVERSED',
  );
});

test('reverseRepayment: puts the money back on exactly the debts it came off', async () => {
  const payment = {
    _id: 'pay1',
    type: CREDIT_TX_TYPES.PAYMENT,
    amount: 800,
    reversedBy: null,
    customer: 'cust1',
    allocations: [
      { transaction: 'd1', amount: 600 },
      { transaction: 'd2', amount: 200 },
    ],
    async save() { return this; },
  };
  const d1 = makeDebt({ id: 'd1', amount: 600, outstanding: 0, dueAt: '2026-09-01', status: 'paid' });
  const d2 = makeDebt({ id: 'd2', amount: 400, outstanding: 200, dueAt: '2026-09-10' });
  const debtsById = { d1, d2 };

  stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 800 } });
  mock.method(CreditTransaction, 'findOne', (query) => ({ session: async () => debtsById[query._id] }));
  stubFind(CreditTransaction, []);
  let created;
  mock.method(CreditTransaction, 'create', async ([doc]) => { created = doc; return [{ ...doc, _id: 'rev1' }]; });
  stubExists(CreditTransaction, { _id: 'x' });

  await reverseRepayment({ shop: SHOP, transaction: payment, user: USER, session: null, reason: 'Wrong customer' });

  // Restored per-debt, so aging and due dates return to what they were rather
  // than the balance reappearing as one undated lump.
  assert.equal(d1.outstanding, 600);
  assert.equal(d1.status, 'outstanding');
  assert.equal(d2.outstanding, 400);
  assert.equal(created.type, CREDIT_TX_TYPES.PAYMENT_REVERSAL);
  assert.equal(created.reversalOf, 'pay1');
  assert.equal(payment.reversedBy, 'rev1');
});

test('reverseRepayment: never resurrects a debt that was itself cancelled', async () => {
  const payment = {
    _id: 'pay1', type: CREDIT_TX_TYPES.PAYMENT, amount: 500, reversedBy: null, customer: 'cust1',
    allocations: [{ transaction: 'd1', amount: 500 }],
    async save() { return this; },
  };
  const cancelled = makeDebt({ id: 'd1', amount: 500, outstanding: 0, dueAt: '2026-09-01', status: 'reversed' });

  stubCustomerUpdate({ _id: 'cust1', credit: { outstanding: 500 } });
  mock.method(CreditTransaction, 'findOne', () => ({ session: async () => cancelled }));
  stubFind(CreditTransaction, []);
  mock.method(CreditTransaction, 'create', async ([doc]) => [{ ...doc, _id: 'rev1' }]);
  stubExists(CreditTransaction, { _id: 'x' });

  await reverseRepayment({ shop: SHOP, transaction: payment, user: USER, session: null, reason: 'x' });

  assert.equal(cancelled.outstanding, 0, 'a cancelled sale stays cancelled');
  assert.equal(cancelled.status, 'reversed');
});

test('reverseRepayment: refuses anything that is not a repayment, or one already undone', async () => {
  await assert.rejects(
    reverseRepayment({ shop: SHOP, transaction: { type: CREDIT_TX_TYPES.SALE }, user: USER, session: null }),
    (err) => err.code === 'NOT_A_PAYMENT',
  );
  await assert.rejects(
    reverseRepayment({
      shop: SHOP, transaction: { type: CREDIT_TX_TYPES.PAYMENT, reversedBy: 'rev1' }, user: USER, session: null,
    }),
    (err) => err.code === 'ALREADY_REVERSED',
  );
});

// ── Rollup ──────────────────────────────────────────────────────────────────

test('recomputeCustomerCredit: derives overdue from due dates, ignoring settled debts', async () => {
  const now = new Date('2026-09-14T12:00:00');
  stubFind(CreditTransaction, [
    { outstanding: 300, dueAt: new Date('2026-09-01') },  // matured
    { outstanding: 200, dueAt: new Date('2026-09-30') },  // not yet
  ]);
  stubExists(CreditTransaction, { _id: 'x' });
  const calls = stubCustomerUpdate({ _id: 'cust1' });

  await recomputeCustomerCredit('cust1', null, { now });

  const { $set } = calls[0].update;
  assert.equal($set['credit.outstanding'], 500);
  assert.equal($set['credit.overdueAmount'], 300, 'only the matured portion');
  assert.equal($set['credit.oldestDueAt'].toISOString(), new Date('2026-09-01').toISOString());
  assert.equal($set['credit.status'], 'overdue');
});

test('recomputeCustomerCredit: "paid" and "never borrowed" are different facts', async () => {
  const now = new Date('2026-09-14T12:00:00');
  stubFind(CreditTransaction, []);
  stubExists(CreditTransaction, { _id: 'past-debt' });
  let calls = stubCustomerUpdate({ _id: 'cust1' });
  await recomputeCustomerCredit('cust1', null, { now });
  // An owner reads "cleared their debt" and "never asked for credit" very
  // differently when deciding who to trust.
  assert.equal(calls[0].update.$set['credit.status'], 'paid');

  mock.restoreAll();
  stubFind(CreditTransaction, []);
  stubExists(CreditTransaction, null);
  calls = stubCustomerUpdate({ _id: 'cust2' });
  await recomputeCustomerCredit('cust2', null, { now });
  assert.equal(calls[0].update.$set['credit.status'], 'none');
});

test('recomputeCustomerCredit: a debt due today is current, not overdue', async () => {
  const now = new Date('2026-09-14T12:00:00');
  stubFind(CreditTransaction, [{ outstanding: 500, dueAt: new Date('2026-09-14T23:59:59.999') }]);
  stubExists(CreditTransaction, { _id: 'x' });
  const calls = stubCustomerUpdate({ _id: 'cust1' });

  await recomputeCustomerCredit('cust1', null, { now });
  assert.equal(calls[0].update.$set['credit.status'], 'current');
  assert.equal(calls[0].update.$set['credit.overdueAmount'], 0);
});

// ── Account summary ─────────────────────────────────────────────────────────

test('summariseAccount: available credit is the limit minus what is owed, never negative', () => {
  const account = summariseAccount(
    { isActive: true, credit: { limit: null, outstanding: 2800 } },
    SETTINGS,
  );
  assert.equal(account.creditLimit, 3000);
  assert.equal(account.creditLimitSource, 'shop');
  assert.equal(account.availableCredit, 200);
  assert.equal(account.canTakeCredit, true);

  // An opening balance can legitimately put someone over their ceiling.
  // Available must floor at zero rather than reporting a negative allowance.
  const over = summariseAccount({ isActive: true, credit: { limit: 1000, outstanding: 9000 } }, SETTINGS);
  assert.equal(over.availableCredit, 0);
  assert.equal(over.canTakeCredit, false);
  assert.equal(over.creditLimitSource, 'customer');
});

test('summariseAccount: every reason the till would refuse is answered before a basket is filled', () => {
  const base = { isActive: true, credit: { limit: 5000, outstanding: 0 } };

  assert.equal(summariseAccount(base, { ...SETTINGS, enabled: false }).canTakeCredit, false);
  assert.equal(summariseAccount({ ...base, isActive: false }, SETTINGS).canTakeCredit, false);
  assert.equal(
    summariseAccount({ ...base, credit: { ...base.credit, blocked: true } }, SETTINGS).canTakeCredit,
    false,
  );

  const overdue = { isActive: true, credit: { limit: 5000, outstanding: 500, oldestDueAt: new Date('2020-01-01') } };
  assert.equal(summariseAccount(overdue, SETTINGS).canTakeCredit, false, 'BLOCK bars an overdue customer');
  assert.equal(
    summariseAccount(overdue, { ...SETTINGS, overduePolicy: 'ALLOW' }).canTakeCredit,
    true,
    'ALLOW lets them keep buying inside their limit',
  );
});

test('summariseAccount: daysOverdue is computed server-side, never left for a client to derive', () => {
  const now = new Date('2026-09-14T12:00:00');
  const overdue = summariseAccount(
    { isActive: true, credit: { limit: 5000, outstanding: 500, oldestDueAt: new Date('2026-09-10T23:59:59.999') } },
    SETTINGS,
    { now },
  );
  assert.equal(overdue.daysOverdue, 3);

  // Not overdue, or no debt at all: 0, never undefined or a negative number a
  // client would have to defend against when it renders "X days overdue".
  const current = summariseAccount(
    { isActive: true, credit: { limit: 5000, outstanding: 500, oldestDueAt: new Date('2026-09-20') } },
    SETTINGS,
    { now },
  );
  assert.equal(current.daysOverdue, 0);

  const clear = summariseAccount({ isActive: true, credit: { limit: 5000, outstanding: 0, oldestDueAt: null } }, SETTINGS, { now });
  assert.equal(clear.daysOverdue, 0);
});

test('summariseAccount: dueAtPreview is computed from the shop term, not sent by a client', () => {
  const now = new Date('2026-09-14T09:00:00');
  const account = summariseAccount({ isActive: true, credit: { limit: 5000, outstanding: 0 } }, SETTINGS, { now });
  assert.equal(account.dueAtPreview.getDate(), 21);
  assert.equal(account.dueAtPreview.getHours(), 23);
});
