import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDIT_TX_SIGN,
  CREDIT_TX_TYPES,
  DEBT_TX_TYPES,
  DEFAULT_CREDIT_SETTINGS,
  MONEY_EPSILON,
  collectionPeriodLabel,
  computeDueAt,
  daysOverdue,
  effectiveCreditLimit,
  isCreditEnabled,
  money,
  resolveCreditSettings,
} from '../src/constants/credit.js';

/**
 * The rules a credit decision is made from, tested in isolation.
 *
 * These are the calculations an owner would redo by hand if they disagreed
 * with the app — a due date, a days-late count, how much someone can still
 * take. Getting one wrong is not a display bug; it is the shop chasing the
 * wrong person on the wrong day.
 */

// ── Settings resolution ─────────────────────────────────────────────────────

test('resolveCreditSettings: a shop that predates the feature reads as credit-off', () => {
  // The case that matters on day one: every existing shop has no subdocument,
  // and a `lean()` read gives back no defaults either.
  assert.deepEqual(resolveCreditSettings({}), DEFAULT_CREDIT_SETTINGS);
  assert.deepEqual(resolveCreditSettings(null), DEFAULT_CREDIT_SETTINGS);
  assert.deepEqual(resolveCreditSettings({ creditSettings: undefined }), DEFAULT_CREDIT_SETTINGS);
  assert.equal(isCreditEnabled({}), false);
});

test('resolveCreditSettings: a partial stored subdocument still yields every field', () => {
  const settings = resolveCreditSettings({ creditSettings: { enabled: true, defaultCreditLimit: 5000 } });
  assert.equal(settings.enabled, true);
  assert.equal(settings.defaultCreditLimit, 5000);
  // Untouched fields fall back rather than coming through undefined, which is
  // what would otherwise reach a $ifNull in the limit guard.
  assert.equal(settings.defaultCollectionPeriodDays, 7);
  assert.equal(settings.productPolicy, 'ALL_PRODUCTS');
  assert.equal(settings.overduePolicy, 'BLOCK');
});

test('resolveCreditSettings: unwraps a Mongoose subdocument', () => {
  const doc = { creditSettings: { toObject: () => ({ enabled: true, overduePolicy: 'ALLOW' }) } };
  const settings = resolveCreditSettings(doc);
  assert.equal(settings.enabled, true);
  assert.equal(settings.overduePolicy, 'ALLOW');
  assert.equal(settings.defaultCollectionPeriodDays, 7);
});

test('the shipped default is credit off, blocking overdue, all products', () => {
  // Extending credit must never be something a shop discovers it is doing.
  assert.equal(DEFAULT_CREDIT_SETTINGS.enabled, false);
  assert.equal(DEFAULT_CREDIT_SETTINGS.overduePolicy, 'BLOCK');
  assert.equal(DEFAULT_CREDIT_SETTINGS.defaultCreditLimit, 0);
});

// ── Credit limit ────────────────────────────────────────────────────────────

test('effectiveCreditLimit: a customer with no limit of their own follows the shop', () => {
  const settings = { defaultCreditLimit: 2000 };
  assert.equal(effectiveCreditLimit({ credit: { limit: null } }, settings), 2000);
  assert.equal(effectiveCreditLimit({ credit: {} }, settings), 2000);
  assert.equal(effectiveCreditLimit({}, settings), 2000);
});

test('effectiveCreditLimit: a customer-specific limit overrides the shop default in both directions', () => {
  const settings = { defaultCreditLimit: 2000 };
  assert.equal(effectiveCreditLimit({ credit: { limit: 10000 } }, settings), 10000);
  assert.equal(effectiveCreditLimit({ credit: { limit: 500 } }, settings), 500);
  // Zero is a real decision ("this person takes no credit"), not "unset" —
  // treating it as unset would silently hand them the shop default.
  assert.equal(effectiveCreditLimit({ credit: { limit: 0 } }, settings), 0);
});

// ── Due dates ───────────────────────────────────────────────────────────────

test('computeDueAt: a term runs to the close of the last day, not the hour of sale', () => {
  const sold = new Date('2026-09-14T09:30:00');
  const due = computeDueAt(sold, 3);
  assert.equal(due.getDate(), 17);
  assert.equal(due.getHours(), 23);
  assert.equal(due.getMinutes(), 59);
  // A debt taken at 09:30 on a 3-day term is not overdue at 09:31 three days
  // later — nobody in a shop counts a due date by the hour.
  assert.equal(daysOverdue(due, new Date('2026-09-17T18:00:00')), 0);
});

test('computeDueAt: immediate (0 days) means end of the same day', () => {
  const sold = new Date('2026-09-14T09:30:00');
  const due = computeDueAt(sold, 0);
  assert.equal(due.getDate(), 14);
  assert.equal(due.getHours(), 23);
  assert.equal(daysOverdue(due, new Date('2026-09-14T22:00:00')), 0);
  assert.equal(daysOverdue(due, new Date('2026-09-15T08:00:00')), 0, 'the next morning is not yet a full day late');
});

test('computeDueAt: crosses month and year boundaries', () => {
  const endOfMonth = computeDueAt(new Date('2026-08-20T10:00:00'), 30);
  assert.equal(endOfMonth.getMonth(), 8, 'August + 30 days lands in September');
  assert.equal(endOfMonth.getDate(), 19);

  const endOfYear = computeDueAt(new Date('2026-12-28T10:00:00'), 7);
  assert.equal(endOfYear.getFullYear(), 2027);
  assert.equal(endOfYear.getMonth(), 0);
  assert.equal(endOfYear.getDate(), 4);
});

test('computeDueAt: a missing or negative period is treated as immediate, never as a crash', () => {
  const sold = new Date('2026-09-14T09:30:00');
  assert.equal(computeDueAt(sold, undefined).getDate(), 14);
  assert.equal(computeDueAt(sold, null).getDate(), 14);
  assert.equal(computeDueAt(sold, -5).getDate(), 14);
  assert.equal(computeDueAt(sold, 3.9).getDate(), 17, 'fractional days truncate');
});

test('daysOverdue: counts whole days late and never goes negative', () => {
  const due = new Date('2026-09-10T23:59:59.999');
  assert.equal(daysOverdue(due, new Date('2026-09-09T12:00:00')), 0, 'not yet due');
  assert.equal(daysOverdue(due, new Date('2026-09-10T23:00:00')), 0, 'due today is not late');
  assert.equal(daysOverdue(due, new Date('2026-09-12T08:00:00')), 1);
  assert.equal(daysOverdue(due, new Date('2026-09-20T08:00:00')), 9);
  assert.equal(daysOverdue(null), 0);
});

// ── Money ───────────────────────────────────────────────────────────────────

test('money: rounds to cents rather than carrying float noise into the ledger', () => {
  assert.equal(money(0.1 + 0.2), 0.3);
  assert.equal(money(1999.999), 2000);
  assert.equal(money(1999.994), 1999.99);
  assert.equal(money(100), 100);
  assert.equal(money(1.005), 1.01);
});

test('the epsilon is big enough to absorb accumulated part-payment drift, small enough to be sub-cent', () => {
  // Twelve part-payments against a 1,000 debt: the residue must land inside
  // the epsilon, or an exact payoff would be rejected as "more than is owed".
  let outstanding = 1000;
  for (let i = 0; i < 12; i += 1) outstanding = money(outstanding - 83.33);
  const residue = Math.abs(outstanding - (1000 - 12 * 83.33));
  assert.ok(residue < MONEY_EPSILON, `residue ${residue} must be inside the epsilon`);
  assert.ok(MONEY_EPSILON < 0.01, 'the epsilon must never forgive a whole cent');
});

// ── Ledger vocabulary ───────────────────────────────────────────────────────

test('every transaction type has a direction, and debts are the collectable ones', () => {
  for (const type of Object.values(CREDIT_TX_TYPES)) {
    assert.ok(CREDIT_TX_SIGN[type] === 1 || CREDIT_TX_SIGN[type] === -1, `${type} needs a direction`);
  }
  // A sale and an opening balance are the two things a customer can be chased
  // for; a payment and either reversal are movements against them.
  assert.deepEqual(DEBT_TX_TYPES, [CREDIT_TX_TYPES.SALE, CREDIT_TX_TYPES.OPENING_BALANCE]);
  assert.equal(CREDIT_TX_SIGN[CREDIT_TX_TYPES.PAYMENT], -1);
  assert.equal(CREDIT_TX_SIGN[CREDIT_TX_TYPES.SALE_REVERSAL], -1);
  assert.equal(CREDIT_TX_SIGN[CREDIT_TX_TYPES.PAYMENT_REVERSAL], 1);
});

test('collectionPeriodLabel speaks in shop terms, not day counts', () => {
  assert.equal(collectionPeriodLabel(0), 'Due same day');
  assert.equal(collectionPeriodLabel(7), 'Due in 1 week');
  assert.equal(collectionPeriodLabel(14), 'Due in 2 weeks');
  assert.equal(collectionPeriodLabel(30), 'Due in 1 month');
  assert.equal(collectionPeriodLabel(5), 'Due in 5 days');
});
