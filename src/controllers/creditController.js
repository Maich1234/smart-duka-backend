import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import CreditTransaction from '../models/CreditTransaction.js';
import Sale from '../models/Sale.js';
import { parsePagination } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { logAudit } from '../services/auditLogService.js';
import { getActiveShift } from '../services/shiftService.js';
import {
  enabledMethodKeys,
  methodLabel,
  CASH_METHOD_KEY,
} from '../constants/salePaymentMethods.js';
import {
  CREDIT_METHOD_KEY,
  CREDIT_TX_TYPES,
  DEBT_TX_TYPES,
  MONEY_EPSILON,
  daysOverdue,
  money,
  resolveCreditSettings,
} from '../constants/credit.js';
import {
  CreditRejection,
  bookDebt,
  canRecordCreditPayment,
  canViewAllCredit,
  ledgerScopeFor,
  recordRepayment,
  reverseDebt,
  reverseRepayment,
  summariseAccount,
} from '../services/creditService.js';

/**
 * The Credit section: the shop's debt book, repayments, corrections, and the
 * one-time import of debts that predate this feature.
 *
 * Authorization convention matches every other controller here — the route
 * checks the role, the handler checks the permission, and every query is
 * scoped to `req.user.shop._id` from the session.
 */

/** Turns a CreditRejection into the response it describes; rethrows anything else. */
const handleRejection = (error, res) => {
  if (error instanceof CreditRejection) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  throw error;
};

/**
 * GET /credit/overview — the owner's whole book at a glance, plus the list
 * that's actually actionable: who is overdue, by how much, and for how long.
 *
 * Four figures and a list, not a wall of cards. The totals come from an
 * aggregate over the customer rollups rather than the ledger, because the
 * rollups are already consistent with it and a shop with years of history
 * shouldn't pay for a full ledger scan to draw a header.
 */
export const getCreditOverview = async (req, res) => {
  if (!canViewAllCredit(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const settings = resolveCreditSettings(req.user.shop);
  const now = new Date();

  const [totals] = await Customer.aggregate([
    { $match: { shop: new mongoose.Types.ObjectId(String(shop)), 'credit.outstanding': { $gt: MONEY_EPSILON } } },
    {
      $group: {
        _id: null,
        totalOutstanding: { $sum: '$credit.outstanding' },
        totalOverdue: { $sum: '$credit.overdueAmount' },
        customersOwing: { $sum: 1 },
        customersOverdue: { $sum: { $cond: [{ $eq: ['$credit.status', 'overdue'] }, 1, 0] } },
      },
    },
  ]);

  // The overdue list is driven by oldestDueAt rather than the stored status,
  // so a debt that matured since the nightly sweep still shows up the morning
  // the owner opens the screen.
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20 });
  const overdueQuery = {
    shop,
    'credit.outstanding': { $gt: MONEY_EPSILON },
    'credit.oldestDueAt': { $ne: null, $lte: now },
  };
  const [overdueCustomers, overdueTotal] = await Promise.all([
    Customer.find(overdueQuery)
      .select('name phone credit')
      .sort({ 'credit.oldestDueAt': 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Customer.countDocuments(overdueQuery),
  ]);

  res.json({
    success: true,
    data: {
      enabled: settings.enabled,
      settings,
      totals: {
        totalOutstanding: money(totals?.totalOutstanding ?? 0),
        totalOverdue: money(totals?.totalOverdue ?? 0),
        customersOwing: totals?.customersOwing ?? 0,
        customersOverdue: totals?.customersOverdue ?? 0,
      },
      overdue: overdueCustomers.map((c) => ({
        _id: c._id,
        name: c.name,
        phone: c.phone,
        outstanding: money(c.credit?.outstanding ?? 0),
        overdueAmount: money(c.credit?.overdueAmount ?? c.credit?.outstanding ?? 0),
        dueAt: c.credit?.oldestDueAt ?? null,
        daysOverdue: daysOverdue(c.credit?.oldestDueAt, now),
      })),
      pagination: { page, limit, total: overdueTotal, pages: Math.ceil(overdueTotal / limit) },
    },
  });
};

/**
 * GET /credit/transactions — the ledger, always narrowed by the database.
 *
 * A staff member without view_all_credit has `staff: their own id` merged into
 * the query by ledgerScopeFor, and a `staffId` they pass is discarded. That is
 * the same shape reconciliationController uses for cashier data, and for the
 * same reason: a filter the client supplies must never be able to widen scope.
 */
export const getCreditTransactions = async (req, res) => {
  const user = req.user;
  const isOwnScope = !canViewAllCredit(user);
  if (isOwnScope && !user.permissions?.includes('view_own_credit') && !canRecordCreditPayment(user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = user.shop._id;
  const { customerId, type, status, overdueOnly, startDate, endDate, staffId } = req.query;
  const { page, limit, skip } = parsePagination(req.query);

  const query = { shop, ...ledgerScopeFor(user) };
  if (customerId) query.customer = customerId;
  if (type) query.type = type;
  if (status) query.status = status;
  if (overdueOnly) {
    query.type = { $in: DEBT_TX_TYPES };
    query.status = 'outstanding';
    query.dueAt = { $lte: new Date() };
  }
  if (startDate || endDate) {
    query.createdAt = {
      ...(startDate ? { $gte: new Date(startDate) } : {}),
      ...(endDate ? { $lte: new Date(endDate) } : {}),
    };
  }
  // Only honoured for a caller whose scope wasn't already pinned above.
  if (staffId && !isOwnScope) query.staff = staffId;

  const [transactions, total] = await Promise.all([
    CreditTransaction.find(query)
      .populate('customer', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CreditTransaction.countDocuments(query),
  ]);

  res.json({
    success: true,
    data: transactions,
    scopedToSelf: isOwnScope,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

/**
 * POST /credit/customers/:id/payments — money in against a debt.
 *
 * Works whether or not the shop currently has credit switched on: a shop that
 * stops lending still has to collect what it is already owed, and blocking
 * that would strand every open debt.
 *
 * Runs under the idempotency middleware, and the ledger row additionally
 * carries the request's key on a unique index — so a retry can never book a
 * second repayment even after the idempotency record has aged out.
 */
export const recordCreditPayment = async (req, res) => {
  if (!canRecordCreditPayment(req.user)) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop;
  const shopId = shop._id;
  const { amount, paymentMethod, reference, note } = req.body;

  // Repayments use the shop's own money-in buttons, so a repayment lands in
  // reconciliation the same way a sale does. `credit` itself is excluded —
  // paying a debt with credit is not a payment.
  const allowed = enabledMethodKeys(shop).filter((k) => k !== CREDIT_METHOD_KEY);
  if (!allowed.includes(paymentMethod)) {
    return res.status(400).json({
      success: false,
      code: 'PAYMENT_METHOD_UNAVAILABLE',
      message: `'${paymentMethod}' is not one of this shop's payment methods.`,
    });
  }

  const customer = await Customer.findOne({ _id: req.params.id, shop: shopId }).select('_id name').lean();
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  // Cash through the drawer belongs to a shift, exactly like a cash sale, or
  // the drawer won't reconcile at close.
  let activeShift = null;
  if (shop.shiftManagementEnabled) {
    activeShift = await getActiveShift(req.user._id);
  }

  const clientRef = req.headers['x-idempotency-key'] ?? req.headers['idempotency-key'] ?? null;
  const session = await mongoose.startSession();

  try {
    let result;
    // withTransaction, not a manual commit: the guarded balance decrement and
    // the per-debt allocation updates all touch documents another till may be
    // writing, and a WriteConflict there must retry rather than 500 at the
    // counter. The body re-derives everything from req on each attempt.
    await session.withTransaction(async () => {
      result = await recordRepayment({
        shop,
        customerId: customer._id,
        amount,
        paymentMethod,
        paymentMethodLabel: methodLabel(shop, paymentMethod),
        reference: reference ?? '',
        user: req.user,
        session,
        shiftId: activeShift?._id ?? null,
        clientRef: typeof clientRef === 'string' ? clientRef : null,
      });
    });

    const settings = resolveCreditSettings(shop);
    const account = summariseAccount(result.customer, settings);

    await logAudit({
      shopId,
      userId: req.user._id,
      action: 'credit.payment.recorded',
      entityType: 'CreditTransaction',
      entityId: result.transaction._id,
      details: {
        customerId: String(customer._id),
        amount: money(amount),
        paymentMethod,
        balanceAfter: account.outstanding,
        ...(note ? { note } : {}),
      },
      req,
    });

    res.status(201).json({
      success: true,
      data: { transaction: result.transaction, account, customerName: customer.name },
      message: account.outstanding <= MONEY_EPSILON
        ? `${customer.name} is now fully paid up.`
        : 'Payment recorded.',
    });
  } catch (error) {
    // A duplicate clientRef means a retry raced past the idempotency record.
    // The first attempt succeeded, so this is a success from the caller's
    // point of view — never a second repayment.
    if (error?.code === 11000 && error?.keyPattern?.clientRef) {
      const existing = await CreditTransaction.findOne({ shop: shopId, clientRef }).lean();
      if (existing) {
        return res.status(200).json({
          success: true,
          data: { transaction: existing },
          message: 'Payment already recorded.',
        });
      }
    }
    return handleRejection(error, res);
  } finally {
    session.endSession();
  }
};

/**
 * POST /credit/transactions/:id/reverse — the controlled correction path.
 *
 * Owner-only, and it never edits the original row: it writes a compensating
 * entry pointing back at it and marks the original reversed. A reason is
 * required, and the whole thing is audit-logged with who, when and why.
 */
export const reverseCreditTransaction = async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({
      success: false,
      message: 'Only the shop owner can reverse a credit entry.',
    });
  }

  const shop = req.user.shop;
  const shopId = shop._id;
  const { reason } = req.body;
  const session = await mongoose.startSession();

  try {
    let result;
    let originalType;
    await session.withTransaction(async () => {
      const transaction = await CreditTransaction.findOne({
        _id: req.params.id,
        shop: shopId,
      }).session(session);
      if (!transaction) {
        throw new CreditRejection(404, 'NOT_FOUND', 'That credit entry was not found.');
      }
      originalType = transaction.type;

      if (DEBT_TX_TYPES.includes(transaction.type)) {
        result = await reverseDebt({ shop, transaction, user: req.user, session, reason });
      } else if (transaction.type === CREDIT_TX_TYPES.PAYMENT) {
        result = await reverseRepayment({ shop, transaction, user: req.user, session, reason });
      } else {
        throw new CreditRejection(
          400,
          'NOT_REVERSIBLE',
          'That entry is itself a correction and cannot be reversed again.',
        );
      }
    });

    await logAudit({
      shopId,
      userId: req.user._id,
      action: 'credit.transaction.reversed',
      entityType: 'CreditTransaction',
      entityId: req.params.id,
      details: {
        originalType,
        reversalId: String(result.transaction._id),
        amount: result.transaction.amount,
        reason,
      },
      req,
    });

    const settings = resolveCreditSettings(shop);
    res.status(201).json({
      success: true,
      data: {
        transaction: result.transaction,
        account: summariseAccount(result.customer, settings),
      },
      message: 'Entry reversed. The original stays in the history with a correction beside it.',
    });
  } catch (error) {
    return handleRejection(error, res);
  } finally {
    session.endSession();
  }
};

/**
 * GET /credit/untracked-sales — past sales marked "Credit" that were never
 * tracked as debts.
 *
 * Before this module existed, a shop could add the suggested "Credit (Deni)"
 * till button and it did nothing but label the sale. Those sales are real money
 * someone may still owe, and there is no way for the system to know who. This
 * lists them so the owner can say.
 */
export const getUntrackedCreditSales = async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const { search } = req.query;
  const { page, limit, skip } = parsePagination(req.query);

  const query = {
    shop,
    paymentMethod: CREDIT_METHOD_KEY,
    status: 'completed',
    // Never assigned to a customer — a sale that has one is already tracked.
    customer: { $exists: false },
  };
  if (search) query.invoiceNumber = { $regex: escapeRegex(search), $options: 'i' };

  const [sales, total] = await Promise.all([
    Sale.find(query)
      .select('invoiceNumber totalAmount createdAt items staff')
      .populate('staff', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Sale.countDocuments(query),
  ]);

  res.json({
    success: true,
    data: sales.map((s) => ({
      _id: s._id,
      invoiceNumber: s.invoiceNumber,
      totalAmount: s.totalAmount,
      createdAt: s.createdAt,
      staffName: s.staff?.name ?? '',
      itemSummary: (s.items ?? []).map((i) => i.productName).slice(0, 3).join(', '),
      itemCount: (s.items ?? []).length,
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

/**
 * POST /credit/opening-balances — brings an existing debt onto the books.
 *
 * Two uses, one mechanism: assigning a customer to one of the untracked sales
 * above (`saleId` given), or recording a debt that only ever lived on a
 * chalkboard (no `saleId`).
 *
 * Deliberately bypasses the credit limit. The owner is recording money they are
 * already owed, not extending new credit — refusing would leave the shop unable
 * to write down a debt that exists. The customer may then legitimately sit over
 * their limit, which correctly blocks *new* credit until they pay down. The row
 * is typed CREDIT_OPENING_BALANCE so a statement never claims the shop sold
 * something it didn't, and the whole action is audit-logged.
 */
export const recordOpeningBalance = async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({
      success: false,
      message: 'Only the shop owner can bring an existing debt onto the books.',
    });
  }

  const shop = req.user.shop;
  const shopId = shop._id;
  const settings = resolveCreditSettings(shop);
  const { customerId, amount, dueAt, saleId, note } = req.body;

  const customer = await Customer.findOne({ _id: customerId, shop: shopId }).select('_id name isActive').lean();
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }
  if (customer.isActive === false) {
    return res.status(400).json({
      success: false,
      code: 'CUSTOMER_ARCHIVED',
      message: `${customer.name} is archived. Restore them before recording a balance.`,
    });
  }

  let sale = null;
  if (saleId) {
    sale = await Sale.findOne({ _id: saleId, shop: shopId });
    if (!sale) {
      return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    if (sale.customer) {
      return res.status(400).json({
        success: false,
        code: 'SALE_ALREADY_ASSIGNED',
        message: 'That sale has already been assigned to a customer.',
      });
    }
    if (sale.paymentMethod !== CREDIT_METHOD_KEY) {
      return res.status(400).json({
        success: false,
        code: 'SALE_NOT_CREDIT',
        message: 'Only a sale recorded as Credit can be brought forward as a debt.',
      });
    }
    if (money(amount) > money(sale.totalAmount) + MONEY_EPSILON) {
      return res.status(400).json({
        success: false,
        code: 'AMOUNT_EXCEEDS_SALE',
        message: 'That is more than the sale was worth. Enter the amount still owed on it.',
      });
    }
  }

  const clientRef = req.headers['x-idempotency-key'] ?? req.headers['idempotency-key'] ?? null;
  const session = await mongoose.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      result = await bookDebt({
        type: CREDIT_TX_TYPES.OPENING_BALANCE,
        shop,
        customerId: customer._id,
        amount,
        settings,
        user: req.user,
        session,
        saleId: sale?._id ?? null,
        clientRef: typeof clientRef === 'string' ? clientRef : null,
        dueAt: dueAt ? new Date(dueAt) : undefined,
        reason: note ?? '',
        enforceLimit: false,
      });

      if (sale) {
        // Stamp the sale so it leaves the untracked list, and so the customer's
        // purchase history shows the sale this debt came from.
        sale.customer = customer._id;
        sale.customerName = customer.name;
        await sale.save({ session });
      }
    });

    await logAudit({
      shopId,
      userId: req.user._id,
      action: 'credit.opening_balance.recorded',
      entityType: 'CreditTransaction',
      entityId: result.transaction._id,
      details: {
        customerId: String(customer._id),
        amount: money(amount),
        dueAt: result.transaction.dueAt,
        ...(sale ? { saleId: String(sale._id), invoiceNumber: sale.invoiceNumber } : {}),
        ...(note ? { note } : {}),
      },
      req,
    });

    res.status(201).json({
      success: true,
      data: {
        transaction: result.transaction,
        account: summariseAccount(result.customer, settings),
      },
      message: `${money(amount)} brought forward for ${customer.name}.`,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_IMPORTED',
        message: 'That debt has already been brought forward.',
      });
    }
    return handleRejection(error, res);
  } finally {
    session.endSession();
  }
};

/**
 * The repayment methods a client should offer: the shop's own money-in buttons
 * minus credit itself. Exposed so the RecordPayment sheet never has to
 * reimplement that rule and drift from it.
 */
export const getRepaymentMethods = (shop) =>
  enabledMethodKeys(shop)
    .filter((k) => k !== CREDIT_METHOD_KEY)
    .map((key) => ({ key, label: methodLabel(shop, key) }))
    // Cash first: it is what most repayments actually are.
    .sort((a, b) => (a.key === CASH_METHOD_KEY ? -1 : b.key === CASH_METHOD_KEY ? 1 : 0));
