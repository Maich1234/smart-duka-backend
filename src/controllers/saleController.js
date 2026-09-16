import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import User from '../models/User.js';
import MpesaTransaction from '../models/MpesaTransaction.js';
import PaymentConfig from '../models/PaymentConfig.js';
import { signReceiptToken } from '../utils/receiptToken.js';
import { resolveSaleLine, SaleLineError } from '../services/pricingEngine.js';
import { getCommissionSummary } from '../services/commissionService.js';
import { restoreSaleStock } from '../services/saleStockService.js';
import { initiateReversal, withMpesaCallbackSecret } from '../services/mpesaService.js';
import { logAudit } from '../services/auditLogService.js';
import { getActiveShift } from '../services/shiftService.js';
import { parsePagination, paginatedResult } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { sendPushToUser } from '../utils/push.js';
import {
  MPESA_METHOD_KEY,
  enabledMethodKeys,
  methodLabel,
} from '../constants/salePaymentMethods.js';
import Customer from '../models/Customer.js';
import CreditTransaction from '../models/CreditTransaction.js';
import { CREDIT_METHOD_KEY, DEBT_TX_TYPES, resolveCreditSettings } from '../constants/credit.js';
import {
  CreditRejection,
  assertProductsCreditEligible,
  bookDebt,
  canMakeCreditSale,
  reverseDebt,
  summariseAccount,
} from '../services/creditService.js';

/**
 * A client-facing rejection (out of stock, unknown product) raised from inside
 * a transaction body so the transaction aborts cleanly. Carries no transient-
 * error label, so withTransaction propagates it instead of retrying — unlike a
 * WriteConflict, retrying "out of stock" would never succeed.
 */
class SaleRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SaleRejection';
    this.status = status;
  }
}

/**
 * Alerts every owner of the shop that a sale just took one or more items
 * below zero stock. This is allowed — a shop can sell ahead of what's been
 * entered as purchased — but the owner needs to know so they can true up
 * inventory. Best-effort per owner, mirrors notifyOwnersShiftClosed in
 * shiftController.js.
 */
const notifyOwnersNegativeStock = async (shop, staffName, items) => {
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
  const shop = req.user.shop._id;

  // Credit is behaviour, not a label: once the owner switches the module on,
  // the till may take credit whether or not they ever added the button to
  // their own list. (Before the module existed, `credit` was merely one of the
  // suggested buttons in salePaymentMethods.js, recording a sale and nothing
  // else — shops that used it that way keep working exactly as before while
  // the module is off. See creditSale below.)
  const creditSettings = resolveCreditSettings(req.user.shop);
  const isCreditSale = paymentMethod === CREDIT_METHOD_KEY && creditSettings.enabled;

  // The shop's own button list is the authority on what's a valid method —
  // Joi only checked the key's shape, since it can't see the shop.
  const allowedMethods = enabledMethodKeys(req.user.shop);
  if (!allowedMethods.includes(paymentMethod) && !isCreditSale) {
    // Coded so clients can react (refetch the shop's till buttons, drop the
    // stale selection) rather than just surfacing the message — this fires
    // whenever an owner removes/disables a method after it was already
    // selected on someone else's till but before their poll/focus refetch
    // caught up.
    return res.status(400).json({
      success: false,
      code: 'PAYMENT_METHOD_UNAVAILABLE',
      message: `'${paymentMethod}' is not one of this shop's payment methods.`,
    });
  }

  // ── Credit preconditions ────────────────────────────────────────────────
  // Everything cheap and shop-independent is settled here, before a
  // transaction is opened: permission, a named customer, and that the customer
  // belongs to this shop. The limit itself is checked inside the transaction,
  // where it can be checked atomically.
  let creditCustomer = null;
  if (paymentMethod === CREDIT_METHOD_KEY && creditSettings.enabled) {
    if (!canMakeCreditSale(req.user)) {
      return res.status(403).json({
        success: false,
        code: 'CREDIT_PERMISSION_DENIED',
        message: 'You don\'t have permission to sell on credit.',
      });
    }
    if (!customerId) {
      return res.status(400).json({
        success: false,
        code: 'CUSTOMER_REQUIRED',
        message: 'Choose a customer before selling on credit.',
      });
    }
    // Scoped to the shop from the session, never from the request — a customer
    // id from another shop simply isn't found here.
    creditCustomer = await Customer.findOne({ _id: customerId, shop }).select('_id name isActive').lean();
    if (!creditCustomer) {
      return res.status(404).json({ success: false, code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
    }
  }

  // A customer on an ordinary (non-credit) sale: optional, and equally
  // shop-scoped. Lets a shop attach a regular to a cash purchase without that
  // sale becoming a debt.
  let saleCustomer = creditCustomer;
  if (!saleCustomer && customerId) {
    saleCustomer = await Customer.findOne({ _id: customerId, shop }).select('_id name').lean();
    if (!saleCustomer) {
      return res.status(404).json({ success: false, code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
    }
  }

  // With shift management on, staff must be clocked in before selling so
  // every transaction reconciles to a drawer. Owners are exempt from the
  // gate but their sales still link to a shift when they've opened one.
  let activeShift = null;
  if (req.user.shop?.shiftManagementEnabled) {
    activeShift = await getActiveShift(req.user._id);
    if (!activeShift && req.user.role !== 'owner') {
      return res.status(403).json({
        success: false,
        code: 'SHIFT_REQUIRED',
        message: 'Start your shift before recording sales.',
      });
    }
  }

  // For M-Pesa sales, verify or record the payment reference — when there is
  // one. A shop that takes M-Pesa on a Pochi or a personal number has no STK
  // Push and no way to produce a transaction id; that sale records like cash.
  let mpesaTx = null;
  if (paymentMethod === MPESA_METHOD_KEY) {
    if (mpesaTransactionId) {
      // Normal STK push flow — confirm the transaction succeeded
      mpesaTx = await MpesaTransaction.findOne({ _id: mpesaTransactionId, shop, status: 'success' });
      if (!mpesaTx) {
        return res.status(400).json({ success: false, message: 'M-Pesa payment not confirmed. Please wait for payment confirmation before recording the sale.' });
      }
      if (mpesaTx.saleId) {
        return res.status(400).json({ success: false, message: 'This M-Pesa transaction has already been linked to a sale.' });
      }
    } else if (mpesaReceiptNumber) {
      // Offline manual entry — staff entered the code from the customer's confirmation SMS.
      // Try to link to an existing Safaricom transaction if the callback has already arrived.
      mpesaTx = await MpesaTransaction.findOne({ mpesaReceiptNumber, shop }).catch(() => null);
      if (mpesaTx?.saleId) {
        return res.status(400).json({ success: false, message: 'This M-Pesa receipt has already been linked to a sale.' });
      }
    }
  }
  // The same key the idempotency middleware keyed this request on. Stamped
  // onto the ledger row under a unique index, so a retry can never book a
  // second debt even after the IdempotencyRecord has aged out of its 72h
  // window — a debt outliving its dedupe record is exactly the case that must
  // not double-charge a customer.
  const idempotencyKey = req.headers['x-idempotency-key'] ?? req.headers['idempotency-key'] ?? null;
  const session = await mongoose.startSession();

  try {
    let sale;
    let saleItems;
    let negativeStockAlerts;
    let creditResult;

    // withTransaction (not a bare startTransaction/commitTransaction pair)
    // because MongoDB raises a WriteConflict whenever two transactions touch
    // the same product document concurrently — two tills ringing up the same
    // fast-moving SKU at the same moment. Manual commits surface that as a
    // 500 at the counter; withTransaction retries transient errors for us.
    // The body must therefore be idempotent and re-runnable: every mutation
    // below is derived fresh from `items` on each attempt.
    // Commission is per-seller: shops routinely put only part of the floor on
    // commission, so staff are opted in individually.
    //
    // Owners never accrue it, even on lines they ring up themselves.
    // Commission is booked as a "Staff commission" operating expense in the
    // P&L (services/books/profitLossService.js), and an owner pays themselves
    // no such wage — recording it would deduct a payout that never happens and
    // understate their own profit.
    //
    // Resolved once outside the retry body because it can't change mid-transaction.
    const earnsCommission = req.user.role === 'staff' && req.user.commissionEligible === true;

    await session.withTransaction(async () => {
      let totalAmount = 0;
      let totalCommission = 0;
      saleItems = [];
      negativeStockAlerts = [];
      creditResult = null;
      // Keeps every product/bundle-component doc touched during this sale in
      // memory so it's mutated and saved exactly once, even when referenced
      // by more than one cart line (e.g. shared bundle components). Rebuilt
      // per attempt — reusing docs across retries would replay stale versions.
      const productCache = new Map();

      // One round trip for the whole basket instead of one per line. A 20-item
      // cart used to be 20 sequential queries holding the transaction (and its
      // locks) open the entire time, which itself provoked write conflicts.
      const productIds = [...new Set(items.filter((i) => i.productId).map((i) => String(i.productId)))];
      const products = await Product.find({ _id: { $in: productIds }, shop }).session(session);
      for (const product of products) productCache.set(product._id.toString(), product);

      for (const item of items) {
        if (!item.productId) {
          const quantity = Number(item.quantity);
          const unitPrice = Number(item.unitPrice);
          const subtotalLine = Math.round(quantity * unitPrice * 100) / 100;
          totalAmount += subtotalLine;
          saleItems.push({
            productName: item.name,
            quantity,
            unitPrice,
            unitCost: null,
            costTotal: null,
            subtotal: subtotalLine,
            discountAmount: 0,
            commissionAmount: 0,
            productType: 'service',
          });
          continue;
        }
        const product = productCache.get(String(item.productId));
        if (!product) {
          throw new SaleRejection(400, `Product with ID ${item.productId} not found in this shop`);
        }

        let resolved;
        try {
          resolved = await resolveSaleLine(product, item, { shop, session, productCache, negativeStockAlerts });
        } catch (err) {
          if (err instanceof SaleLineError) throw new SaleRejection(err.status, err.message);
          throw err;
        }

        totalAmount += resolved.subtotal;
        const lineCommission = earnsCommission ? (resolved.commissionAmount || 0) : 0;
        totalCommission += lineCommission;
        // Cost is charged on the full quantity, not the discounted/payable one:
        // goods given away under a promotion still cost the shop money.
        const unitCost = resolved.unitCost ?? null;
        saleItems.push({
          productId: product._id,
          productName: product.name,
          quantity: resolved.quantity,
          unitPrice: resolved.unitPrice,
          unitCost,
          costTotal: unitCost === null
            ? null
            : Math.round(unitCost * resolved.quantity * 100) / 100,
          subtotal: resolved.subtotal,
          discountAmount: resolved.discountAmount || 0,
          appliedPromotionLabel: resolved.appliedPromotionLabel,
          commissionAmount: lineCommission,
          variantId: resolved.variantId,
          variantName: resolved.variantName,
          unitOfMeasure: resolved.unitOfMeasure,
          productType: resolved.productType,
        });
      }

      for (const doc of productCache.values()) {
        await doc.save({ session });
      }

      // Product credit eligibility, checked against the products this
      // transaction actually loaded rather than anything the client asserted.
      // Under SELECTED_PRODUCTS an unflagged product fails closed and the
      // rejection names it, so the cashier isn't left hunting the cart.
      if (isCreditSale) {
        assertProductsCreditEligible([...productCache.values()], creditSettings);
      }

      [sale] = await Sale.create([{
        shop,
        items: saleItems,
        totalAmount,
        totalCommission,
        paymentMethod,
        paymentMethodLabel: isCreditSale && !allowedMethods.includes(paymentMethod)
          // The shop never added a Credit button, so there is no label of
          // theirs to snapshot. Name it plainly rather than leaving the
          // receipt blank.
          ? 'Credit'
          : methodLabel(req.user.shop, paymentMethod),
        staff: req.user._id,
        ...(saleCustomer ? { customer: saleCustomer._id, customerName: saleCustomer.name } : {}),
        ...(activeShift ? { shift: activeShift._id } : {}),
        ...(mpesaTx ? {
          mpesaTransactionId: mpesaTx._id,
          mpesaReceiptNumber: mpesaTx.mpesaReceiptNumber,
        } : mpesaReceiptNumber ? {
          // Offline manual entry — receipt number recorded as-is; no linked transaction yet
          mpesaReceiptNumber,
        } : {}),
      }], { session });

      // Claim the M-Pesa transaction atomically, inside the same transaction
      // as the sale it pays for. The `mpesaTx.saleId` check above ran before
      // this transaction started, so it can't see a concurrent createSale
      // request for the same transactionId (e.g. two client-side retries
      // carrying different idempotency keys) — both could read `saleId: null`
      // and both reach here. This conditional update is the actual guard:
      // MongoDB serializes concurrent writes to the same document, so at most
      // one of two racing transactions matches `saleId: null` and commits: the
      // other gets a WriteConflict, withTransaction retries it, and the retry
      // sees `saleId` already set and lands in the throw below — a clean 400,
      // not a second sale for the same payment.
      if (mpesaTx) {
        const claimed = await MpesaTransaction.findOneAndUpdate(
          { _id: mpesaTx._id, saleId: null },
          { $set: { saleId: sale._id } },
          { session },
        );
        if (!claimed) {
          throw new SaleRejection(400, 'This M-Pesa transaction has already been linked to a sale.');
        }
      }

      // The debt itself — booked last, with the server's own totalAmount and a
      // server-computed due date. Nothing the client sent about limits,
      // balances or dates is consulted anywhere in this path.
      //
      // Inside the same transaction as the stock movement and the sale row, so
      // the three commit together or not at all: a shop can never end up with
      // stock gone and no debt recorded, or a debt recorded against a sale that
      // rolled back. bookDebt's own guard is what serializes two tills selling
      // to the same customer at once — see creditService.
      if (isCreditSale) {
        creditResult = await bookDebt({
          shop: req.user.shop,
          customerId: creditCustomer._id,
          amount: totalAmount,
          settings: creditSettings,
          user: req.user,
          session,
          saleId: sale._id,
          shiftId: activeShift?._id ?? null,
          clientRef: typeof idempotencyKey === 'string' ? idempotencyKey : null,
        });
      }
    });

    const saleObj = sale.toObject();
    saleObj.receiptToken = signReceiptToken(sale._id);
    if (creditResult) {
      // What the receipt and the confirmation need: when it's due, and where
      // the customer now stands. Server-computed, so the client displays it
      // rather than deriving it.
      saleObj.credit = {
        transactionId: creditResult.transaction._id,
        dueAt: creditResult.transaction.dueAt,
        account: summariseAccount(creditResult.customer, creditSettings),
      };
    }
    if (negativeStockAlerts.length > 0) {
      // Awaited (not fire-and-forget): this backend runs on Vercel, which
      // kills async work started after the response goes out.
      await notifyOwnersNegativeStock(shop, req.user.name, negativeStockAlerts);
    }
    res.status(201).json({
      success: true,
      data: saleObj,
      message: creditResult
        ? `Sale recorded on ${creditCustomer.name}'s account.`
        : 'Sale recorded successfully',
    });
  } catch (error) {
    if (error instanceof SaleRejection) {
      return res.status(error.status).json({ success: false, message: error.message });
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
  } finally {
    session.endSession();
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