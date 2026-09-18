import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import MpesaTransaction from '../models/MpesaTransaction.js';
import Customer from '../models/Customer.js';
import { signReceiptToken } from '../utils/receiptToken.js';
import { resolveSaleLine, SaleLineError } from './pricingEngine.js';
import {
  MPESA_METHOD_KEY,
  enabledMethodKeys,
  methodLabel,
} from '../constants/salePaymentMethods.js';
import { CREDIT_METHOD_KEY, resolveCreditSettings } from '../constants/credit.js';
import {
  assertProductsCreditEligible,
  bookDebt,
  canMakeCreditSale,
  summariseAccount,
} from './creditService.js';
import { getActiveShift } from './shiftService.js';

/**
 * A client-facing rejection (unavailable payment method, permission denied,
 * unknown customer/product, out of stock, ...) raised while creating a sale
 * so the caller can turn it into a clean HTTP response instead of a 500. The
 * optional `code` mirrors the machine-readable codes some of these responses
 * carried before this was a thrown error (e.g. PAYMENT_METHOD_UNAVAILABLE) so
 * clients can still react to them, not just show the message. When thrown
 * from inside the transaction body it carries no transient-error label, so
 * withTransaction propagates it instead of retrying — unlike a WriteConflict,
 * retrying "out of stock" would never succeed.
 */
export class SaleRejection extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'SaleRejection';
    this.status = status;
    this.code = code;
  }
}

/**
 * The transactional heart of "create a Sale": payment/credit/shift
 * preconditions, stock decrement, commission, credit booking, invoiceNumber
 * assignment. Used by both the till's POST /sales handler and quotation
 * convert-to-sale, so there is exactly one code path in this codebase that
 * creates a Sale.
 */
export const createSaleTransaction = async ({
  user,
  items,
  paymentMethod,
  mpesaTransactionId,
  mpesaReceiptNumber,
  customerId,
  idempotencyKey,
  beforeCommit,
}) => {
  const shop = user.shop._id;

  // Credit is behaviour, not a label: once the owner switches the module on,
  // the till may take credit whether or not they ever added the button to
  // their own list. (Before the module existed, `credit` was merely one of the
  // suggested buttons in salePaymentMethods.js, recording a sale and nothing
  // else — shops that used it that way keep working exactly as before while
  // the module is off. See creditSale below.)
  const creditSettings = resolveCreditSettings(user.shop);
  const isCreditSale = paymentMethod === CREDIT_METHOD_KEY && creditSettings.enabled;

  // The shop's own button list is the authority on what's a valid method —
  // Joi only checked the key's shape, since it can't see the shop.
  const allowedMethods = enabledMethodKeys(user.shop);
  if (!allowedMethods.includes(paymentMethod) && !isCreditSale) {
    // Coded so clients can react (refetch the shop's till buttons, drop the
    // stale selection) rather than just surfacing the message — this fires
    // whenever an owner removes/disables a method after it was already
    // selected on someone else's till but before their poll/focus refetch
    // caught up.
    throw new SaleRejection(400, `'${paymentMethod}' is not one of this shop's payment methods.`, 'PAYMENT_METHOD_UNAVAILABLE');
  }

  // ── Credit preconditions ────────────────────────────────────────────────
  // Everything cheap and shop-independent is settled here, before a
  // transaction is opened: permission, a named customer, and that the customer
  // belongs to this shop. The limit itself is checked inside the transaction,
  // where it can be checked atomically.
  let creditCustomer = null;
  if (paymentMethod === CREDIT_METHOD_KEY && creditSettings.enabled) {
    if (!canMakeCreditSale(user)) {
      throw new SaleRejection(403, 'You don\'t have permission to sell on credit.', 'CREDIT_PERMISSION_DENIED');
    }
    if (!customerId) {
      throw new SaleRejection(400, 'Choose a customer before selling on credit.', 'CUSTOMER_REQUIRED');
    }
    // Scoped to the shop from the session, never from the request — a customer
    // id from another shop simply isn't found here.
    creditCustomer = await Customer.findOne({ _id: customerId, shop }).select('_id name isActive').lean();
    if (!creditCustomer) {
      throw new SaleRejection(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
    }
  }

  // A customer on an ordinary (non-credit) sale: optional, and equally
  // shop-scoped. Lets a shop attach a regular to a cash purchase without that
  // sale becoming a debt.
  let saleCustomer = creditCustomer;
  if (!saleCustomer && customerId) {
    saleCustomer = await Customer.findOne({ _id: customerId, shop }).select('_id name').lean();
    if (!saleCustomer) {
      throw new SaleRejection(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
    }
  }

  // With shift management on, staff must be clocked in before selling so
  // every transaction reconciles to a drawer. Owners are exempt from the
  // gate but their sales still link to a shift when they've opened one.
  let activeShift = null;
  if (user.shop?.shiftManagementEnabled) {
    activeShift = await getActiveShift(user._id);
    if (!activeShift && user.role !== 'owner') {
      throw new SaleRejection(403, 'Start your shift before recording sales.', 'SHIFT_REQUIRED');
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
        throw new SaleRejection(400, 'M-Pesa payment not confirmed. Please wait for payment confirmation before recording the sale.');
      }
      if (mpesaTx.saleId) {
        throw new SaleRejection(400, 'This M-Pesa transaction has already been linked to a sale.');
      }
    } else if (mpesaReceiptNumber) {
      // Offline manual entry — staff entered the code from the customer's confirmation SMS.
      // Try to link to an existing Safaricom transaction if the callback has already arrived.
      mpesaTx = await MpesaTransaction.findOne({ mpesaReceiptNumber, shop }).catch(() => null);
      if (mpesaTx?.saleId) {
        throw new SaleRejection(400, 'This M-Pesa receipt has already been linked to a sale.');
      }
    }
  }

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
    const earnsCommission = user.role === 'staff' && user.commissionEligible === true;

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
          : methodLabel(user.shop, paymentMethod),
        staff: user._id,
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
          shop: user.shop,
          customerId: creditCustomer._id,
          amount: totalAmount,
          settings: creditSettings,
          user,
          session,
          saleId: sale._id,
          shiftId: activeShift?._id ?? null,
          clientRef: typeof idempotencyKey === 'string' ? idempotencyKey : null,
        });
      }

      if (beforeCommit) {
        await beforeCommit(session, sale);
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

    return {
      sale,
      saleObj,
      creditResult,
      negativeStockAlerts,
      creditCustomerName: creditCustomer?.name ?? null,
    };
  } finally {
    session.endSession();
  }
};
