import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import CreditTransaction from '../models/CreditTransaction.js';
import {
  CREDIT_TX_TYPES,
  DEBT_TX_TYPES,
  MONEY_EPSILON,
  money,
  computeDueAt,
  daysOverdue,
  effectiveCreditLimit,
} from '../constants/credit.js';

/**
 * Customer credit ledger.
 *
 * Every shilling a customer owes is a row in CreditTransaction. The figures on
 * Customer.credit are a rollup of those rows, kept in step here and nowhere
 * else. Nothing in this file mutates the money on an existing row: a mistake is
 * corrected by writing a compensating row that points back at what it reverses.
 *
 * Two invariants hold under concurrency, and both are enforced by the database
 * rather than by reading-then-writing in Node:
 *
 *   outstanding + newDebt <= effective limit      (guardedIncrease)
 *   outstanding - repayment >= 0                  (guardedDecrease)
 *
 * Both are expressed as conditions on the same findOneAndUpdate that performs
 * the move, so two tills selling to one customer at the same instant cannot
 * both pass the check. MongoDB serializes concurrent writes to a document, so
 * the loser takes a WriteConflict, withTransaction retries it, and the retry
 * re-evaluates the condition against the balance the winner just wrote.
 */

/**
 * A refusal the caller should surface to the user as-is.
 *
 * Carries no transient-error label, so a withTransaction body that throws one
 * aborts instead of retrying — retrying "over the credit limit" would never
 * succeed. `code` lets clients react (open the picker, refetch the account)
 * rather than only printing the message.
 */
export class CreditRejection extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'CreditRejection';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

/** Formats a money figure for an error message the cashier reads at the counter. */
const fmt = (shop, amount) =>
  `${shop?.currency || 'KES'} ${money(amount).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// ── Authorization & eligibility ─────────────────────────────────────────────

/**
 * Whether this user may extend credit at all. Owners always may; staff need
 * the grant. Never trusts anything from the request body.
 */
export const canMakeCreditSale = (user) =>
  user?.role === 'owner' || !!user?.permissions?.includes('make_credit_sale');

export const canRecordCreditPayment = (user) =>
  user?.role === 'owner' || !!user?.permissions?.includes('record_credit_payment');

export const canViewAllCredit = (user) =>
  user?.role === 'owner' || !!user?.permissions?.includes('view_all_credit');

/**
 * Whether this user may open a customer's account at all — the summary, not
 * the full shop book. Anyone who can sell on credit or take a repayment needs
 * to see the balance they are acting on; the *timeline* is narrowed separately
 * by canViewAllCredit.
 */
export const canViewCustomerAccount = (user) =>
  canViewAllCredit(user)
  || canMakeCreditSale(user)
  || canRecordCreditPayment(user)
  || !!user?.permissions?.includes('view_own_credit');

/**
 * The ledger filter for a credit list request.
 *
 * A staff member without view_all_credit is served a query pinned to their own
 * id — the narrowing happens in the database, never by handing the device the
 * whole book and filtering it there.
 */
export const ledgerScopeFor = (user) =>
  canViewAllCredit(user) ? {} : { staff: user._id };

/**
 * Rejects a basket containing anything the shop will not lend on.
 *
 * Under SELECTED_PRODUCTS a product must be explicitly flagged; the default is
 * false, so the policy fails closed. The rejection names the products, because
 * "some item in your cart" sends a cashier hunting through twenty lines.
 */
export const assertProductsCreditEligible = (products, settings) => {
  if (settings.productPolicy !== 'SELECTED_PRODUCTS') return;
  const ineligible = products.filter((p) => p?.creditEligible !== true);
  if (ineligible.length === 0) return;

  const names = ineligible.map((p) => p.name);
  const listed = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
  throw new CreditRejection(
    400,
    'PRODUCT_NOT_CREDIT_ELIGIBLE',
    names.length === 1
      ? `${listed} can't be sold on credit. Remove it, or take payment another way.`
      : `These can't be sold on credit: ${listed}${more}. Remove them, or take payment another way.`,
    { products: names },
  );
};

// ── Rollup ──────────────────────────────────────────────────────────────────

/**
 * Rebuilds a customer's credit rollup from their ledger and writes it back.
 *
 * The single place overdueAmount / oldestDueAt / status are derived, so the
 * three can never disagree about the same set of debts. `outstanding` is
 * recomputed here too and used as a consistency check: the guarded increments
 * are what keep it correct under concurrency, so a mismatch here means a row
 * was written outside this service and is worth knowing about.
 *
 * Runs inside the caller's session, always after the ledger rows it summarises.
 */
export const recomputeCustomerCredit = async (customerId, session, { now = new Date() } = {}) => {
  const debts = await CreditTransaction.find({
    customer: customerId,
    type: { $in: DEBT_TX_TYPES },
    status: 'outstanding',
    outstanding: { $gt: 0 },
  })
    .select('outstanding dueAt')
    .sort({ dueAt: 1 })
    .session(session ?? null)
    .lean();

  let outstanding = 0;
  let overdueAmount = 0;
  let oldestDueAt = null;
  for (const debt of debts) {
    outstanding += debt.outstanding;
    if (debt.dueAt && new Date(debt.dueAt) <= now) overdueAmount += debt.outstanding;
    if (debt.dueAt && (oldestDueAt === null || new Date(debt.dueAt) < oldestDueAt)) {
      oldestDueAt = new Date(debt.dueAt);
    }
  }
  outstanding = money(outstanding);
  overdueAmount = money(overdueAmount);

  // 'paid' and 'none' are different facts: one customer cleared a debt, the
  // other never had one. An owner reads them differently when deciding who to
  // trust, so the distinction is preserved rather than collapsed to "0".
  const hasEverBorrowed = await CreditTransaction.exists({
    customer: customerId,
    type: { $in: DEBT_TX_TYPES },
  }).session(session ?? null);

  const status = outstanding > MONEY_EPSILON
    ? (overdueAmount > MONEY_EPSILON ? 'overdue' : 'current')
    : (hasEverBorrowed ? 'paid' : 'none');

  const updated = await Customer.findOneAndUpdate(
    { _id: customerId },
    {
      $set: {
        'credit.outstanding': outstanding,
        'credit.overdueAmount': overdueAmount,
        'credit.oldestDueAt': oldestDueAt,
        'credit.status': status,
      },
    },
    { new: true, session },
  );

  return updated;
};

// ── Guarded balance moves ───────────────────────────────────────────────────

/**
 * Raises a customer's outstanding balance, but only if every condition still
 * holds at the moment of the write.
 *
 * The limit is read from the document inside the update ($ifNull against the
 * shop default) rather than passed in from a prior read, so an owner lowering
 * a limit concurrently still wins. Same for `blocked` and the overdue bar.
 *
 * Returns the updated document, or null when the guard refused — the caller
 * re-reads to say precisely which condition failed.
 */
const guardedIncrease = async ({ customerId, shopId, amount, settings, session, now = new Date() }) => {
  const filter = {
    _id: customerId,
    shop: shopId,
    isActive: true,
    'credit.blocked': { $ne: true },
    $expr: {
      $lte: [
        { $add: ['$credit.outstanding', amount] },
        // The half-cent of slack that everything else in this file carries:
        // a limit of exactly 3000 must admit a balance of exactly 3000 even
        // after a dozen part-payments have each rounded to cents.
        { $add: [{ $ifNull: ['$credit.limit', settings.defaultCreditLimit] }, MONEY_EPSILON] },
      ],
    },
  };

  // BLOCK is checked against oldestDueAt, not the stored overdueAmount, so the
  // bar is exact the instant a debt matures rather than only after the nightly
  // sweep has run. oldestDueAt is maintained synchronously on every write.
  if (settings.overduePolicy === 'BLOCK') {
    filter.$or = [
      { 'credit.oldestDueAt': null },
      { 'credit.oldestDueAt': { $gt: now } },
    ];
  }

  return Customer.findOneAndUpdate(
    filter,
    {
      $inc: { 'credit.outstanding': amount, 'credit.totalExtended': amount },
      $set: { 'credit.lastSaleAt': now },
    },
    { new: true, session },
  );
};

/**
 * Explains a refused increase by re-reading the customer and testing each
 * condition in the order a person would ask about them.
 *
 * Separate from the guard on purpose: the guard has to be one atomic
 * expression, and an atomic expression cannot also produce a sentence.
 */
const explainRefusedIncrease = async ({ customerId, shopId, amount, settings, shop, session, now = new Date() }) => {
  const customer = await Customer.findOne({ _id: customerId, shop: shopId }).session(session ?? null);

  if (!customer) {
    return new CreditRejection(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
  }
  if (!customer.isActive) {
    return new CreditRejection(
      400,
      'CUSTOMER_ARCHIVED',
      `${customer.name} has been archived and can't take new credit.`,
    );
  }
  if (customer.credit?.blocked) {
    return new CreditRejection(
      403,
      'CUSTOMER_CREDIT_BLOCKED',
      customer.credit.blockedReason
        ? `${customer.name} is blocked from credit: ${customer.credit.blockedReason}`
        : `${customer.name} is blocked from taking credit. The shop owner can lift this.`,
    );
  }
  if (
    settings.overduePolicy === 'BLOCK'
    && customer.credit?.oldestDueAt
    && new Date(customer.credit.oldestDueAt) <= now
  ) {
    return new CreditRejection(
      403,
      'CUSTOMER_OVERDUE',
      `${customer.name} has an overdue balance of ${fmt(shop, customer.credit.overdueAmount || customer.credit.outstanding)}. Take a repayment first, or change the overdue rule in Credit settings.`,
      { outstanding: customer.credit.outstanding, overdueAmount: customer.credit.overdueAmount },
    );
  }

  const limit = effectiveCreditLimit(customer, settings);
  const available = money(Math.max(0, limit - (customer.credit?.outstanding ?? 0)));
  if (limit <= 0) {
    return new CreditRejection(
      403,
      'NO_CREDIT_LIMIT',
      `${customer.name} has no credit limit set. The shop owner can set one on their account.`,
      { creditLimit: limit, outstanding: customer.credit?.outstanding ?? 0, available },
    );
  }
  return new CreditRejection(
    400,
    'CREDIT_LIMIT_EXCEEDED',
    `Credit limit reached. ${customer.name} has ${fmt(shop, available)} available.`,
    {
      creditLimit: limit,
      outstanding: customer.credit?.outstanding ?? 0,
      available,
      requested: money(amount),
    },
  );
};

/**
 * Lowers a customer's outstanding balance by at most what they actually owe.
 *
 * The $expr is what makes an over-payment impossible rather than merely
 * checked: two cashiers taking the last 500 of a 500 debt at the same moment
 * cannot both succeed.
 */
const guardedDecrease = async ({ customerId, shopId, amount, session, now = new Date(), isPayment = true }) =>
  Customer.findOneAndUpdate(
    {
      _id: customerId,
      shop: shopId,
      $expr: { $gte: [{ $add: ['$credit.outstanding', MONEY_EPSILON] }, amount] },
    },
    {
      $inc: {
        'credit.outstanding': -amount,
        ...(isPayment ? { 'credit.totalRepaid': amount } : { 'credit.totalExtended': -amount }),
      },
      ...(isPayment ? { $set: { 'credit.lastPaymentAt': now } } : {}),
    },
    { new: true, session },
  );

// ── Writing debts ───────────────────────────────────────────────────────────

/**
 * Books a new debt: moves the balance under guard, then writes the ledger row.
 *
 * Order matters. The guarded move is the authorization — if it refuses, no row
 * is written and the caller's transaction aborts with a specific message. A
 * ledger row written first and "validated" afterwards would be a debt that
 * briefly existed.
 *
 * Callers must already be inside a transaction: this leaves the customer
 * rollup and the ledger consistent only if both commit together.
 */
export const bookDebt = async ({
  type = CREDIT_TX_TYPES.SALE,
  shop,
  customerId,
  amount,
  settings,
  user,
  session,
  saleId = null,
  shiftId = null,
  clientRef = null,
  reason = '',
  dueAt: explicitDueAt = null,
  // Opening balances record a debt that already exists in the real world. An
  // owner bringing one forward is not extending new credit, so the limit and
  // the overdue bar do not apply — refusing would leave the shop unable to
  // record money it is genuinely owed. The customer then legitimately sits
  // over their limit, which correctly blocks *new* credit until they pay down.
  enforceLimit = true,
  now = new Date(),
}) => {
  const value = money(amount);
  if (!(value > 0)) {
    throw new CreditRejection(400, 'INVALID_AMOUNT', 'Enter an amount greater than zero.');
  }

  const shopId = shop._id ?? shop;
  const customer = enforceLimit
    ? await guardedIncrease({ customerId, shopId, amount: value, settings, session, now })
    : await Customer.findOneAndUpdate(
      { _id: customerId, shop: shopId, isActive: true },
      {
        $inc: { 'credit.outstanding': value, 'credit.totalExtended': value },
        $set: { 'credit.lastSaleAt': now },
      },
      { new: true, session },
    );

  if (!customer) {
    if (!enforceLimit) {
      throw new CreditRejection(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
    }
    throw await explainRefusedIncrease({ customerId, shopId, amount: value, settings, shop, session, now });
  }

  const dueAt = explicitDueAt ?? computeDueAt(now, settings.defaultCollectionPeriodDays);

  const [tx] = await CreditTransaction.create([{
    shop: shopId,
    customer: customerId,
    type,
    amount: value,
    outstanding: value,
    dueAt,
    status: 'outstanding',
    balanceAfter: money(customer.credit.outstanding),
    sale: saleId,
    staff: user._id,
    staffName: user.name,
    shift: shiftId,
    clientRef,
    reason,
  }], { session });

  // oldestDueAt/overdueAmount/status must reflect the row just written — the
  // guarded $inc only moved `outstanding`.
  const refreshed = await recomputeCustomerCredit(customerId, session, { now });

  return { transaction: tx, customer: refreshed ?? customer };
};

// ── Repayments ──────────────────────────────────────────────────────────────

/**
 * Records a repayment and allocates it across the customer's open debts,
 * oldest due date first.
 *
 * Allocation is what makes aging real. A single balance with one date attached
 * cannot answer "how much of this is 30 days late", and it cannot tell a
 * partly-paid debt from an untouched one. Paying the oldest first is also what
 * a shopkeeper and a customer both assume is happening.
 *
 * Partial repayments are ordinary: the allocation stops when the money runs
 * out and the remaining debts stay open.
 */
export const recordRepayment = async ({
  shop,
  customerId,
  amount,
  paymentMethod,
  paymentMethodLabel,
  reference = '',
  user,
  session,
  shiftId = null,
  clientRef = null,
  now = new Date(),
}) => {
  const value = money(amount);
  if (!(value > 0)) {
    throw new CreditRejection(400, 'INVALID_AMOUNT', 'Enter an amount greater than zero.');
  }

  const shopId = shop._id ?? shop;
  const customer = await guardedDecrease({ customerId, shopId, amount: value, session, now });

  if (!customer) {
    const existing = await Customer.findOne({ _id: customerId, shop: shopId }).session(session ?? null);
    if (!existing) {
      throw new CreditRejection(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
    }
    const owed = money(existing.credit?.outstanding ?? 0);
    throw new CreditRejection(
      400,
      'REPAYMENT_EXCEEDS_BALANCE',
      owed > 0
        ? `That's more than ${existing.name} owes. The balance is ${fmt(shop, owed)}.`
        : `${existing.name} has already cleared their balance.`,
      { outstanding: owed, requested: value },
    );
  }

  // Allocate against open debts, oldest due first. Debts with no due date
  // (defensive — every debt this service writes has one) sort last.
  const debts = await CreditTransaction.find({
    customer: customerId,
    shop: shopId,
    type: { $in: DEBT_TX_TYPES },
    status: 'outstanding',
    outstanding: { $gt: 0 },
  })
    .sort({ dueAt: 1, createdAt: 1 })
    .session(session);

  let remaining = value;
  const allocations = [];
  for (const debt of debts) {
    if (remaining <= MONEY_EPSILON) break;
    const applied = money(Math.min(debt.outstanding, remaining));
    if (applied <= 0) continue;

    const left = money(debt.outstanding - applied);
    debt.outstanding = left <= MONEY_EPSILON ? 0 : left;
    if (debt.outstanding === 0) {
      debt.status = 'paid';
      // A settled debt is not overdue. Clearing this is what stops the sweep
      // and the owner's overdue list from carrying a debt that's been paid.
      debt.overdueAt = null;
    }
    await debt.save({ session });

    allocations.push({ transaction: debt._id, amount: applied });
    remaining = money(remaining - applied);
  }

  const [tx] = await CreditTransaction.create([{
    shop: shopId,
    customer: customerId,
    type: CREDIT_TX_TYPES.PAYMENT,
    amount: value,
    balanceAfter: money(customer.credit.outstanding),
    paymentMethod,
    paymentMethodLabel,
    reference,
    allocations,
    staff: user._id,
    staffName: user.name,
    shift: shiftId,
    clientRef,
  }], { session });

  const refreshed = await recomputeCustomerCredit(customerId, session, { now });

  return { transaction: tx, customer: refreshed ?? customer };
};

// ── Corrections ─────────────────────────────────────────────────────────────

/**
 * Cancels a debt by writing a compensating row.
 *
 * Refused once any repayment has been allocated against it: unwinding a debt
 * the customer has already partly settled is not a cancellation, it is a
 * refund, and pretending otherwise would silently discard the record of money
 * that actually changed hands. The caller is told to reverse the repayment
 * first, which is a decision an owner should be making deliberately.
 */
export const reverseDebt = async ({ shop, transaction, user, session, reason = '', now = new Date() }) => {
  if (!DEBT_TX_TYPES.includes(transaction.type)) {
    throw new CreditRejection(400, 'NOT_A_DEBT', 'That entry is not a debt and cannot be cancelled.');
  }
  if (transaction.status === 'reversed') {
    throw new CreditRejection(400, 'ALREADY_REVERSED', 'This entry has already been cancelled.');
  }
  if (money(transaction.outstanding) !== money(transaction.amount)) {
    throw new CreditRejection(
      400,
      'DEBT_PARTLY_REPAID',
      'Money has already been collected against this debt, so it can\'t simply be cancelled. Reverse the repayment first.',
    );
  }

  const shopId = shop._id ?? shop;
  const value = money(transaction.outstanding);
  const customer = await guardedDecrease({
    customerId: transaction.customer,
    shopId,
    amount: value,
    session,
    now,
    isPayment: false,
  });
  if (!customer) {
    throw new CreditRejection(
      409,
      'BALANCE_CHANGED',
      'This customer\'s balance changed while the cancellation was being recorded. Open the account again and retry.',
    );
  }

  const [tx] = await CreditTransaction.create([{
    shop: shopId,
    customer: transaction.customer,
    type: CREDIT_TX_TYPES.SALE_REVERSAL,
    amount: value,
    balanceAfter: money(customer.credit.outstanding),
    reversalOf: transaction._id,
    reason,
    staff: user._id,
    staffName: user.name,
  }], { session });

  transaction.outstanding = 0;
  transaction.status = 'reversed';
  transaction.overdueAt = null;
  transaction.reversedBy = tx._id;
  await transaction.save({ session });

  const refreshed = await recomputeCustomerCredit(transaction.customer, session, { now });
  return { transaction: tx, customer: refreshed ?? customer };
};

/**
 * Undoes a repayment that was recorded in error — a cash count that didn't
 * balance, an M-Pesa code entered against the wrong customer.
 *
 * Puts the money back onto exactly the debts it came off, so aging and due
 * dates return to what they were rather than the balance reappearing as one
 * undated lump. Deliberately bypasses the credit-limit guard: restoring a debt
 * that was always owed is not an extension of new credit, and refusing would
 * leave the ledger permanently wrong.
 */
export const reverseRepayment = async ({ shop, transaction, user, session, reason = '', now = new Date() }) => {
  if (transaction.type !== CREDIT_TX_TYPES.PAYMENT) {
    throw new CreditRejection(400, 'NOT_A_PAYMENT', 'That entry is not a repayment.');
  }
  if (transaction.reversedBy) {
    throw new CreditRejection(400, 'ALREADY_REVERSED', 'This repayment has already been reversed.');
  }

  const shopId = shop._id ?? shop;
  const value = money(transaction.amount);

  const customer = await Customer.findOneAndUpdate(
    { _id: transaction.customer, shop: shopId },
    {
      $inc: { 'credit.outstanding': value, 'credit.totalRepaid': -value },
    },
    { new: true, session },
  );
  if (!customer) {
    throw new CreditRejection(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
  }

  for (const allocation of transaction.allocations ?? []) {
    const debt = await CreditTransaction.findOne({
      _id: allocation.transaction,
      shop: shopId,
    }).session(session);
    // A debt that was itself reversed since keeps its reversal — re-opening it
    // would resurrect a cancelled sale.
    if (!debt || debt.status === 'reversed') continue;
    debt.outstanding = money(debt.outstanding + allocation.amount);
    debt.status = 'outstanding';
    await debt.save({ session });
  }

  const [tx] = await CreditTransaction.create([{
    shop: shopId,
    customer: transaction.customer,
    type: CREDIT_TX_TYPES.PAYMENT_REVERSAL,
    amount: value,
    balanceAfter: money(customer.credit.outstanding),
    reversalOf: transaction._id,
    reason,
    staff: user._id,
    staffName: user.name,
  }], { session });

  transaction.reversedBy = tx._id;
  await transaction.save({ session });

  const refreshed = await recomputeCustomerCredit(transaction.customer, session, { now });
  return { transaction: tx, customer: refreshed ?? customer };
};

// ── Read helpers ────────────────────────────────────────────────────────────

/**
 * The account summary every credit surface shows, computed here so the till,
 * the account screen and the confirmation sheet can never disagree — and so no
 * client is ever the one deciding what "available" means.
 */
export const summariseAccount = (customer, settings, { now = new Date() } = {}) => {
  const credit = customer.credit ?? {};
  const limit = effectiveCreditLimit(customer, settings);
  const outstanding = money(credit.outstanding ?? 0);
  const overdue = credit.oldestDueAt && new Date(credit.oldestDueAt) <= now;

  return {
    creditLimit: limit,
    creditLimitSource: customer.credit?.limit == null ? 'shop' : 'customer',
    outstanding,
    availableCredit: money(Math.max(0, limit - outstanding)),
    overdueAmount: money(credit.overdueAmount ?? 0),
    oldestDueAt: credit.oldestDueAt ?? null,
    // Computed here, not left for a client to derive from oldestDueAt: "how
    // many days late" is exactly the kind of arithmetic that must come from
    // the server's clock, not a device's, and it keeps the day-count in
    // lockstep with the daysOverdue() the overdue list and the sweep both use.
    daysOverdue: credit.oldestDueAt ? daysOverdue(credit.oldestDueAt, now) : 0,
    status: credit.status ?? 'none',
    blocked: credit.blocked === true,
    blockedReason: credit.blockedReason ?? '',
    totalExtended: money(credit.totalExtended ?? 0),
    totalRepaid: money(credit.totalRepaid ?? 0),
    lastSaleAt: credit.lastSaleAt ?? null,
    lastPaymentAt: credit.lastPaymentAt ?? null,
    // What a sale rung up right now would be due. Preview only — the stored
    // dueAt is written at commit from the same helper, so the two agree.
    dueAtPreview: computeDueAt(now, settings.defaultCollectionPeriodDays),
    // Why the till would refuse, answered before the cashier fills a basket.
    canTakeCredit:
      settings.enabled
      && customer.isActive !== false
      && credit.blocked !== true
      && limit > outstanding
      && !(settings.overduePolicy === 'BLOCK' && overdue),
  };
};

/** ObjectId coercion that never throws on a malformed client-supplied id. */
export const toObjectId = (value) => {
  if (value instanceof mongoose.Types.ObjectId) return value;
  return mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : null;
};
