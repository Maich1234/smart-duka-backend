import mongoose from 'mongoose';
import Sale from '../models/Sale.js';
import User from '../models/User.js';
import MpesaTransaction from '../models/MpesaTransaction.js';
import PaymentConfig from '../models/PaymentConfig.js';
import { signReceiptToken } from '../utils/receiptToken.js';
import { getCommissionSummary } from '../services/commissionService.js';
import { restoreSaleStock } from '../services/saleStockService.js';
import { initiateReversal, withMpesaCallbackSecret } from '../services/mpesaService.js';
import { logAudit } from '../services/auditLogService.js';
import { createSaleTransaction, SaleRejection } from '../services/saleCreationService.js';
import { parsePagination, paginatedResult } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { sendPushToUser } from '../utils/push.js';
import { methodLabel } from '../constants/salePaymentMethods.js';
import CreditTransaction from '../models/CreditTransaction.js';
import { DEBT_TX_TYPES } from '../constants/credit.js';
import { CreditRejection, reverseDebt } from '../services/creditService.js';

/**
 * Alerts every owner of the shop that a sale just took one or more items
 * below zero stock. This is allowed — a shop can sell ahead of what's been
 * entered as purchased — but the owner needs to know so they can true up
 * inventory. Best-effort per owner, mirrors notifyOwnersShiftClosed in
 * shiftController.js.
 *
 * Exported for reuse by quotationController.js's convertQuotation, which
 * runs the same createSaleTransaction and needs the same alert.
 */
export const notifyOwnersNegativeStock = async (shop, staffName, items) => {
  const title = items.length === 1
    ? `⚠️ ${items[0].productName} is now below zero stock`
    : `⚠️ ${items.length} items went below zero stock`;
  const body = `${staffName} sold past available stock — ${items
    .map((i) => `${i.productName}: ${i.resultingQuantity}`)
    .join(', ')}`;

  const owners = await User.find({ shop, role: 'owner' });
  for (const owner of owners) {
    await sendPushToUser(owner, {
      title,
      body,
      data: { type: 'negative_stock_alert' },
    }).catch((err) => console.error('[sale] owner negative-stock push failed:', err.message));
  }
};

export const createSale = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('record_sale')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { items, paymentMethod, mpesaTransactionId, mpesaReceiptNumber, customerId } = req.body;
  // The same key the idempotency middleware keyed this request on. Stamped
  // onto the ledger row under a unique index, so a retry can never book a
  // second debt even after the IdempotencyRecord has aged out of its 72h
  // window — a debt outliving its dedupe record is exactly the case that must
  // not double-charge a customer.
  const idempotencyKey = req.headers['x-idempotency-key'] ?? req.headers['idempotency-key'] ?? null;

  try {
    const { saleObj, creditResult, negativeStockAlerts, creditCustomerName } = await createSaleTransaction({
      user: req.user,
      items,
      paymentMethod,
      mpesaTransactionId,
      mpesaReceiptNumber,
      customerId,
      idempotencyKey,
    });

    if (negativeStockAlerts.length > 0) {
      // Awaited (not fire-and-forget): this backend runs on Vercel, which
      // kills async work started after the response goes out.
      await notifyOwnersNegativeStock(req.user.shop._id, req.user.name, negativeStockAlerts);
    }

    res.status(201).json({
      success: true,
      data: saleObj,
      message: creditResult
        ? `Sale recorded on ${creditCustomerName}'s account.`
        : 'Sale recorded successfully',
    });
  } catch (error) {
    if (error instanceof SaleRejection) {
      return res.status(error.status).json({
        success: false,
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
      });
    }
    // A credit refusal (over limit, blocked, overdue, ineligible product)
    // carries the code and the figures the till needs to explain itself.
    if (error instanceof CreditRejection) {
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    throw error;
  }
};

/**
 * POST /sales/:id/void — owner (or staff with 'void_sale') marks a sale
 * voided and restores the stock it deducted. The sale stays in history with
 * a voided badge; every stats/report aggregate excludes it. Runs under the
 * idempotency middleware, so offline-queued retries replay the first result.
 *
 * Stock restore mirrors pricingEngine's deduction paths. It is best-effort
 * per line: products/variants deleted since the sale are skipped rather than
 * blocking the void (the correction of the money record matters most).
 */
export const voidSale = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('void_sale')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const sale = await Sale.findOne({ _id: req.params.id, shop }).session(session);
    if (!sale) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    if (sale.status !== 'completed') {
      await session.abortTransaction();
      session.endSession();
      const why = sale.status === 'voided'
        ? 'This sale has already been voided.'
        : 'This sale has a refund in progress or completed — it can no longer be voided.';
      return res.status(400).json({ success: false, message: why });
    }

    // A voided credit sale must take its debt with it, in the same transaction
    // that restores the stock — otherwise the shop has the goods back and the
    // customer still owes for them.
    //
    // Refused once any repayment has landed against it: unwinding a debt the
    // customer has already partly settled is a refund decision, not a void,
    // and quietly cancelling it would discard the record of money that
    // genuinely changed hands. reverseDebt says so and points at the reversal
    // flow, which is owner-only and demands a reason.
    let creditReversal = null;
    if (sale.customer) {
      const debt = await CreditTransaction.findOne({
        sale: sale._id,
        shop,
        type: { $in: DEBT_TX_TYPES },
        status: 'outstanding',
      }).session(session);

      if (debt) {
        try {
          creditReversal = await reverseDebt({
            shop: req.user.shop,
            transaction: debt,
            user: req.user,
            session,
            reason: req.body?.reason
              ? `Sale voided: ${String(req.body.reason).slice(0, 260)}`
              : 'Sale voided',
          });
        } catch (error) {
          if (error instanceof CreditRejection) {
            await session.abortTransaction();
            session.endSession();
            return res.status(error.status).json({
              success: false,
              code: error.code,
              message: error.code === 'DEBT_PARTLY_REPAID'
                ? 'This credit sale has already been partly repaid, so it can\'t be voided. Reverse the repayment first, or refund the customer.'
                : error.message,
            });
          }
          throw error;
        }
      }
    }

    await restoreSaleStock(sale, session);

    sale.status = 'voided';
    sale.voidedAt = new Date();
    sale.voidedBy = req.user._id;
    if (req.body?.reason) sale.voidReason = String(req.body.reason).slice(0, 300);
    await sale.save({ session });

    await session.commitTransaction();

    res.json({
      success: true,
      data: sale.toObject(),
      message: creditReversal
        ? 'Sale voided, stock restored, and the debt cancelled.'
        : 'Sale voided and stock restored.',
    });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

/** Builds the ResultURL Safaricom posts the reversal outcome to. */
function getReversalResultUrl() {
  if (process.env.MPESA_REVERSAL_RESULT_URL) return process.env.MPESA_REVERSAL_RESULT_URL;
  // Derive from the STK callback URL: .../mpesa/callback → .../mpesa/reversal-result
  const stkUrl = process.env.MPESA_CALLBACK_URL;
  if (stkUrl?.endsWith('/callback')) return stkUrl.replace(/\/callback$/, '/reversal-result');
  return null;
}

/** Extracts a readable Safaricom error out of initiateReversal's thrown message. */
function reversalErrorMessage(err) {
  const jsonMatch = (err.message ?? '').match(/\{.*\}/s);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.errorMessage) return `Safaricom rejected the refund: "${parsed.errorMessage}"`;
    } catch { /* fall through */ }
  }
  if (/ETIMEDOUT|ECONNREFUSED/i.test(err.message)) {
    return 'Could not reach the M-Pesa API. Check your internet connection and try again.';
  }
  if (/decrypt|Security Credential/i.test(err.message)) return err.message;
  return `M-Pesa refund request failed: ${err.message}`;
}

// A reversal whose result callback never arrives would lock the sale in
// 'refund_pending' forever — after this window we let the user retry.
const REFUND_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * POST /sales/:id/refund — returns the customer's money and restores stock.
 *
 * RBAC: owner always; staff need 'refund_own_sales' (own sales only) or
 * 'refund_all_sales' (any sale — implies 'view_all_sales', enforced at grant
 * time in staffController).
 *
 * Cash/card sales (and M-Pesa sales explicitly refunded with body.method
 * 'cash') settle immediately: money is handed over the counter, stock is
 * restored in the same transaction. M-Pesa sales go through Safaricom's
 * Transaction Reversal API: this endpoint initiates the reversal and sets
 * 'refund_pending'; handleReversalResult settles it when Safaricom answers.
 */
export const refundSale = async (req, res) => {
  const isOwner = req.user.role === 'owner';
  const canRefundAll = isOwner || req.user.permissions?.includes('refund_all_sales');
  const canRefundOwn = canRefundAll || req.user.permissions?.includes('refund_own_sales');
  if (!canRefundOwn) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const shop = req.user.shop._id;
  const sale = await Sale.findOne({ _id: req.params.id, shop });
  if (!sale) {
    return res.status(404).json({ success: false, message: 'Sale not found' });
  }
  if (!canRefundAll && sale.staff.toString() !== req.user._id.toString()) {
    return res.status(403).json({ success: false, message: 'You can only refund your own sales.' });
  }
  if (sale.status === 'voided') {
    return res.status(400).json({ success: false, message: 'This sale was voided — there is nothing to refund.' });
  }
  if (sale.status === 'refunded') {
    return res.status(400).json({ success: false, message: 'This sale has already been refunded.' });
  }
  if (sale.status === 'refund_pending') {
    const age = Date.now() - new Date(sale.refund?.requestedAt ?? 0).getTime();
    if (age < REFUND_RETRY_AFTER_MS) {
      return res.status(400).json({ success: false, message: 'A refund for this sale is already being processed by M-Pesa. Please wait for it to complete.' });
    }
    // Result callback never arrived — fall through and let the user retry.
  }

  // A credit sale where the customer hasn't paid yet has no money to give
  // back. Refunding it would hand cash over the counter for a purchase that
  // was never paid for, and leave the debt standing. Voiding is the correct
  // action — it cancels the debt and restores the stock — so say so rather
  // than silently doing the wrong one.
  if (sale.customer) {
    const debt = await CreditTransaction.findOne({
      sale: sale._id,
      shop,
      type: { $in: DEBT_TX_TYPES },
      status: 'outstanding',
    }).lean();
    if (debt && debt.outstanding > 0) {
      const partlyRepaid = debt.outstanding < debt.amount;
      return res.status(400).json({
        success: false,
        code: 'CREDIT_SALE_UNPAID',
        message: partlyRepaid
          ? 'This credit sale is only partly repaid. Reverse the repayment first, then void the sale to cancel what is still owed.'
          : 'This sale was taken on credit and hasn\'t been paid for. Void it instead — that cancels the debt and returns the stock.',
      });
    }
  }

  const reason = req.body?.reason ? String(req.body.reason).slice(0, 300) : undefined;
  const viaMpesa = sale.paymentMethod === 'mpesa' && req.body?.method !== 'cash';

  // ── M-Pesa reversal path ──────────────────────────────────────────────
  if (viaMpesa) {
    // The reversal API refunds by the original payment's receipt number.
    let receiptNumber = sale.mpesaReceiptNumber;
    if (!receiptNumber && sale.mpesaTransactionId) {
      const tx = await MpesaTransaction.findOne({ _id: sale.mpesaTransactionId, shop });
      receiptNumber = tx?.mpesaReceiptNumber;
    }
    if (!receiptNumber) {
      return res.status(400).json({
        success: false,
        message: 'This sale has no M-Pesa receipt number on record, so the payment cannot be reversed automatically. Refund the customer in cash instead.',
      });
    }

    const paymentConfig = await PaymentConfig.findOne({ shop });
    const mpesa = paymentConfig?.mpesa;
    if (!mpesa?.enabled || !mpesa?.consumerKey || !mpesa?.consumerSecret || !mpesa?.shortcode) {
      return res.status(400).json({ success: false, message: 'M-Pesa is not configured for this shop. Set it up in Profile → Payments.' });
    }
    if (!mpesa.initiatorName || !mpesa.securityCredential) {
      return res.status(400).json({
        success: false,
        message: 'M-Pesa refunds need the Initiator Name and Security Credential from the Daraja portal. Add them in Profile → Payments, or refund the customer in cash.',
      });
    }

    const resultUrlBase = getReversalResultUrl();
    const resultUrl = withMpesaCallbackSecret(resultUrlBase);
    const queueTimeoutUrl = resultUrlBase ? withMpesaCallbackSecret(`${resultUrlBase}-timeout`) : null;
    if (!resultUrl || !queueTimeoutUrl) {
      return res.status(503).json({ success: false, message: 'MPESA_REVERSAL_RESULT_URL or MPESA_CALLBACK_SECRET is not configured on the server. Contact the app administrator.' });
    }

    let reversal;
    try {
      reversal = await initiateReversal({
        config: mpesa,
        transactionId: receiptNumber,
        amount: sale.totalAmount,
        remarks: reason || `Refund ${sale.invoiceNumber}`,
        resultUrl,
        queueTimeoutUrl,
      });
    } catch (err) {
      return res.status(503).json({ success: false, message: reversalErrorMessage(err) });
    }

    sale.status = 'refund_pending';
    sale.refund = {
      amount: sale.totalAmount,
      method: 'mpesa',
      reason,
      requestedBy: req.user._id,
      requestedAt: new Date(),
      originatorConversationId: reversal.originatorConversationId,
      conversationId: reversal.conversationId,
    };
    await sale.save();

    logAudit({
      shopId: shop,
      userId: req.user._id,
      action: 'sale.refund.initiated',
      entityType: 'Sale',
      entityId: sale._id,
      details: { amount: sale.totalAmount, method: 'mpesa', receiptNumber, reason },
      req,
    }).catch(() => {});

    return res.json({
      success: true,
      data: sale.toObject(),
      message: 'Refund initiated — M-Pesa is returning the money to the customer. Stock will be restored once it completes.',
    });
  }

  // ── Cash refund path (cash/card sales, or M-Pesa refunded over the counter) ──
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const fresh = await Sale.findOne({ _id: sale._id, shop }).session(session);
    if (!fresh || !['completed', 'refund_pending'].includes(fresh.status)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'This sale can no longer be refunded.' });
    }

    await restoreSaleStock(fresh, session);

    fresh.status = 'refunded';
    fresh.refund = {
      amount: fresh.totalAmount,
      method: 'cash',
      reason,
      requestedBy: req.user._id,
      requestedAt: new Date(),
      completedAt: new Date(),
    };
    await fresh.save({ session });
    await session.commitTransaction();

    logAudit({
      shopId: shop,
      userId: req.user._id,
      action: 'sale.refund.completed',
      entityType: 'Sale',
      entityId: fresh._id,
      details: { amount: fresh.totalAmount, method: 'cash', reason },
      req,
    }).catch(() => {});

    return res.json({ success: true, data: fresh.toObject(), message: 'Sale refunded and stock restored.' });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

export const getSales = async (req, res) => {
  const { startDate, endDate, staffId, status, paymentMethod, search } = req.query;
  const { page, limit, skip } = parsePagination(req.query);
  const query = { shop: req.user.shop._id };

  if (req.user.role === 'owner') {
    if (staffId) query.staff = staffId;
  } else if (req.user.permissions?.includes('view_all_sales')) {
    if (staffId) query.staff = staffId;
  } else {
    query.staff = req.user._id;
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) {
      // The client sends the selected calendar day (typically local
      // midnight) — treat it as inclusive of that whole day, not an exact
      // instant, otherwise every sale made after midnight on the end date
      // (i.e. virtually all of them) gets excluded.
      const endOfDay = new Date(endDate);
      endOfDay.setDate(endOfDay.getDate() + 1);
      query.createdAt.$lt = endOfDay;
    }
  }
  if (paymentMethod) query.paymentMethod = paymentMethod;
  if (status) query.status = status;

  if (search) {
    // Server-side search across invoice number and cashier name so results
    // span the whole dataset, not just the pages a client happens to have
    // loaded. Needs a $lookup because staff is a ref.
    const rx = new RegExp(escapeRegex(search), 'i');
    if (query.staff) query.staff = new mongoose.Types.ObjectId(String(query.staff));
    const [result] = await Sale.aggregate([
      { $match: query },
      { $lookup: { from: 'users', localField: 'staff', foreignField: '_id', as: 'staff' } },
      { $unwind: { path: '$staff', preserveNullAndEmptyArrays: true } },
      { $match: { $or: [{ invoiceNumber: rx }, { 'staff.name': rx }] } },
      // Mirror populate('staff', 'name email') — never ship the full user doc.
      { $addFields: { staff: { _id: '$staff._id', name: '$staff.name', email: '$staff.email' } } },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: 'count' }],
        },
      },
    ]);
    const total = result?.total?.[0]?.count ?? 0;
    return res.json({
      success: true,
      data: result?.data ?? [],
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }

  const result = await paginatedResult(
    { page, limit, skip },
    (s, l) => Sale.find(query).populate('staff', 'name email').skip(s).limit(l).sort({ createdAt: -1 }),
    () => Sale.countDocuments(query),
  );

  res.json({ success: true, ...result });
};

export const getSaleById = async (req, res) => {
  const sale = await Sale.findOne({ _id: req.params.id, shop: req.user.shop._id }).populate('staff', 'name email');
  if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
  if (req.user.role === 'staff' && !req.user.permissions?.includes('view_all_sales') && sale.staff._id.toString() !== req.user._id.toString()) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  const saleObj = sale.toObject();
  saleObj.receiptToken = signReceiptToken(sale._id);
  res.json({ success: true, data: saleObj });
};

export const getSalesStats = async (req, res) => {
  const shop = req.user.shop._id;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  // Voided/refunded sales are corrections — they must not count as revenue.
  // ('refund_pending' still counts: the money is in hand until Safaricom
  // confirms the reversal.)
  const baseQuery = req.user.role === 'owner' || req.user.permissions?.includes('view_all_sales')
    ? { shop, status: { $nin: ['voided', 'refunded'] } }
    : { shop, staff: req.user._id, status: { $nin: ['voided', 'refunded'] } };

  const [thisMonth, lastMonth, methodTotals] = await Promise.all([
    Sale.aggregate([
      { $match: { ...baseQuery, createdAt: { $gte: startOfMonth } } },
      {
        $group: {
          _id: null,
          total: { $sum: '$totalAmount' },
          cashTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$totalAmount', 0] } },
          mpesaTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'mpesa'] }, '$totalAmount', 0] } },
          cardTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, '$totalAmount', 0] } },
          cashCount: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 1, 0] } },
          mpesaCount: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'mpesa'] }, 1, 0] } },
          cardCount: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, 1, 0] } },
          transactionCount: { $sum: 1 },
        },
      },
    ]),
    Sale.aggregate([
      { $match: { ...baseQuery, createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]),
    // Per-method breakdown that isn't limited to cash/mpesa/card — a shop
    // selling on Airtel Money needs to see that money somewhere.
    Sale.aggregate([
      { $match: { ...baseQuery, createdAt: { $gte: startOfMonth } } },
      {
        $group: {
          _id: '$paymentMethod',
          total: { $sum: '$totalAmount' },
          count: { $sum: 1 },
          label: { $last: '$paymentMethodLabel' },
        },
      },
      { $sort: { total: -1 } },
    ]),
  ]);

  const cur = thisMonth[0] || { total: 0, cashTotal: 0, mpesaTotal: 0, cardTotal: 0, cashCount: 0, mpesaCount: 0, cardCount: 0, transactionCount: 0 };
  const lastTotal = lastMonth[0]?.total || 0;
  const percentageChange = lastTotal > 0
    ? Math.round(((cur.total - lastTotal) / lastTotal) * 1000) / 10
    : cur.total > 0 ? 100 : 0;

  res.json({
    success: true,
    data: {
      totalSales: cur.total,
      cashTotal: cur.cashTotal,
      mpesaTotal: cur.mpesaTotal,
      cardTotal: cur.cardTotal,
      cashCount: cur.cashCount,
      mpesaCount: cur.mpesaCount,
      cardCount: cur.cardCount,
      transactionCount: cur.transactionCount,
      avgSale: cur.transactionCount > 0 ? cur.total / cur.transactionCount : 0,
      percentageChange,
      // Every method the shop actually took money on this month. The three
      // *Total fields above stay for older clients.
      byMethod: methodTotals.map((m) => ({
        method: m._id,
        label: m.label || methodLabel(req.user.shop, m._id),
        total: m.total,
        count: m.count,
      })),
    },
  });
};

export const getMySales = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const query = { staff: req.user._id, shop: req.user.shop._id };
  const result = await paginatedResult(
    { page, limit, skip },
    (s, l) => Sale.find(query).skip(s).limit(l).sort({ createdAt: -1 }),
    () => Sale.countDocuments(query),
  );
  res.json({ success: true, ...result });
};

export const getMyCommission = async (req, res) => {
  // Owners always have visibility into their own numbers; staff only see
  // this once the shop owner has opted in via showStaffCommission.
  if (req.user.role === 'staff' && !req.user.shop?.showStaffCommission) {
    return res.status(403).json({
      success: false,
      message: 'Your shop owner has not enabled commission visibility yet.',
    });
  }

  const { startDate, endDate } = req.query;
  const summary = await getCommissionSummary(req.user.shop._id, req.user._id, { startDate, endDate });
  // `eligible` drives whether the client shows the commission surface at all.
  // Only staff ever earn commission (owners take the margin directly), so an
  // owner hitting this endpoint correctly reports as not on commission.
  // Historical earnings still show for someone switched off after earning —
  // the money was earned, so it stays visible.
  res.json({
    success: true,
    data: { ...summary, eligible: req.user.commissionEligible === true },
  });
};