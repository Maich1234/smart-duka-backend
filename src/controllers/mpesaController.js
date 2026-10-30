import mongoose from 'mongoose';
import { enabledMethodKeys, MPESA_METHOD_KEY } from '../constants/salePaymentMethods.js';
import PaymentConfig from '../models/PaymentConfig.js';
import MpesaTransaction from '../models/MpesaTransaction.js';
import Sale from '../models/Sale.js';
import { initiateSTKPush, parseSTKCallback, parseReversalResult, parseB2CResult, normalizeKenyanPhone, withMpesaCallbackSecret } from '../services/mpesaService.js';
import { restoreSaleStock } from '../services/saleStockService.js';
import { logAudit } from '../services/auditLogService.js';
import B2CTransaction from '../models/B2CTransaction.js';
import { notifyCommissionPayoutResult } from '../services/adminNotifyService.js';

/** Validates that all required M-Pesa config fields are present and non-empty. */
function validateMpesaConfig(mpesa) {
  const missing = [];
  if (!mpesa?.enabled)       missing.push('M-Pesa is not enabled');
  if (!mpesa?.shortcode)     missing.push('Shortcode');
  if (!mpesa?.consumerKey)   missing.push('Consumer Key');
  if (!mpesa?.consumerSecret) missing.push('Consumer Secret');
  if (!mpesa?.passkey)       missing.push('Passkey');
  if (!mpesa?.environment)   missing.push('Environment');
  return missing;
}

/** Sends an STK Push to the customer's phone and creates a pending transaction record. */
export const initiatePayment = async (req, res) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;
    const { phoneNumber, amount, accountReference } = req.body;
    // The payment modal sends Idempotency-Key; the shared axios layer sends
    // X-Idempotency-Key on every mutation. Accept either so a retry through
    // either path never fires a second STK push at the customer.
    const idempotencyKey = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];

    // ── 1. Idempotency check — return cached result for duplicate requests ──
    if (idempotencyKey) {
      const existing = await MpesaTransaction.findOne({ shop: shopId, idempotencyKey });
      if (existing) {
        if (existing.status === 'pending') {
          return res.status(200).json({
            success: true,
            idempotent: true,
            data: {
              transactionId: existing._id,
              checkoutRequestId: existing.checkoutRequestId,
              status: 'pending',
            },
            message: 'Payment request already sent. Keep waiting for customer PIN.',
          });
        }
        return res.status(200).json({
          success: true,
          idempotent: true,
          data: {
            transactionId: existing._id,
            checkoutRequestId: existing.checkoutRequestId,
            status: existing.status,
            mpesaReceiptNumber: existing.mpesaReceiptNumber ?? null,
            errorMessage: existing.errorMessage ?? null,
          },
          message: `Duplicate request — transaction already ${existing.status}.`,
        });
      }
    }

    // Recovering an existing request above must remain possible after removal.
    // A fresh request, however, must respect the owner's enabled till methods.
    if (!enabledMethodKeys(req.user.shop).includes(MPESA_METHOD_KEY)) {
      return res.status(400).json({
        success: false,
        code: 'PAYMENT_METHOD_UNAVAILABLE',
        message: 'M-Pesa is no longer enabled in this shop\'s payment methods. Refresh the till and choose an available method.',
      });
    }

    // ── 2. Load and validate M-Pesa configuration ──────────────────────────
    const paymentConfig = await PaymentConfig.findOne({ shop: shopId });
    const mpesaConfig = paymentConfig?.mpesa;
    if (!mpesaConfig) {
      return res.status(400).json({
        success: false,
        message: 'M-Pesa is not configured for this shop. Go to Profile → Payments to connect your M-Pesa Business account.',
      });
    }

    const missingFields = validateMpesaConfig(mpesaConfig);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Incomplete M-Pesa setup. Missing: ${missingFields.join(', ')}. Please update your M-Pesa configuration in Profile → Payments.`,
      });
    }

    const CALLBACK_URL = withMpesaCallbackSecret(process.env.MPESA_CALLBACK_URL);
    if (!CALLBACK_URL) {
      return res.status(503).json({
        success: false,
        message: 'MPESA_CALLBACK_URL or MPESA_CALLBACK_SECRET is not configured on the server. Contact the app administrator.',
      });
    }

    // ── 3. Send STK Push to Safaricom ──────────────────────────────────────
    let stkResult;
    try {
      stkResult = await initiateSTKPush({
        config: mpesaConfig,
        phoneNumber,
        amount,
        accountReference: accountReference || 'DuQana',
        transactionDesc: 'Sale Payment',
        callbackUrl: CALLBACK_URL,
      });
    } catch (err) {
      const message = parseMpesaError(err, mpesaConfig.environment);
      return res.status(503).json({
        success: false,
        message,
        ...(mpesaConfig.environment !== 'production' && { detail: err.message }),
      });
    }

    // ── 4. Record the pending transaction ──────────────────────────────────
    let transaction;
    try {
      transaction = await MpesaTransaction.create({
        shop: shopId,
        checkoutRequestId: stkResult.checkoutRequestId,
        merchantRequestId: stkResult.merchantRequestId,
        phoneNumber: normalizeKenyanPhone(phoneNumber),
        amount,
        accountReference: accountReference || 'DuQana',
        status: 'pending',
        requestedBy: req.user._id,
        ...(idempotencyKey && { idempotencyKey }),
      });
    } catch (err) {
      // Race condition: two simultaneous requests with the same idempotency key both
      // passed the check above, but the second one lost the unique index race.
      // Recover by returning the record the first request created.
      if (err.code === 11000 && idempotencyKey) {
        const existing = await MpesaTransaction.findOne({ shop: shopId, idempotencyKey });
        if (existing) {
          return res.status(200).json({
            success: true,
            idempotent: true,
            data: {
              transactionId: existing._id,
              checkoutRequestId: existing.checkoutRequestId,
              status: existing.status,
            },
            message: 'Payment request already sent. Keep waiting for customer PIN.',
          });
        }
      }
      throw err;
    }

    logAudit({
      shopId,
      userId: req.user._id,
      action: 'mpesa.stk_push.initiated',
      entityType: 'MpesaTransaction',
      entityId: transaction._id,
      details: { phoneNumber: normalizeKenyanPhone(phoneNumber), amount, idempotencyKey },
      req,
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      data: {
        transactionId: transaction._id,
        checkoutRequestId: stkResult.checkoutRequestId,
        status: 'pending',
      },
      message: 'Payment request sent. Waiting for customer to enter PIN.',
    });
  } catch (err) {
    console.error('[M-Pesa Initiate] Unexpected error:', err);
    return res.status(500).json({
      success: false,
      message: 'An unexpected error occurred while initiating the payment. Please try again.',
    });
  }
};

/** Polls the current status of a pending M-Pesa transaction. */
export const getTransactionStatus = async (req, res) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;
    const { transactionId } = req.params;

    const transaction = await MpesaTransaction.findOne({ _id: transactionId, shop: shopId });
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (transaction.status === 'pending') {
      const ageMs = Date.now() - new Date(transaction.createdAt).getTime();
      if (ageMs > 2 * 60 * 1000) {
        transaction.status = 'timeout';
        await transaction.save();
      }
    }

    return res.json({
      success: true,
      data: {
        transactionId: transaction._id,
        status: transaction.status,
        mpesaReceiptNumber: transaction.mpesaReceiptNumber ?? null,
        phoneNumber: transaction.phoneNumber,
        amount: transaction.amount,
        errorMessage: transaction.errorMessage ?? null,
      },
    });
  } catch (err) {
    console.error('[M-Pesa Status] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch transaction status.' });
  }
};

/**
 * Safaricom STK Push callback endpoint — publicly accessible, no JWT auth.
 * Validates, updates the transaction record, and prevents duplicate processing.
 */
export const handleCallback = async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const parsed = parseSTKCallback(req.body);

    const transaction = await MpesaTransaction.findOne({
      checkoutRequestId: parsed.checkoutRequestId,
    });

    if (!transaction) {
      console.error('[M-Pesa Callback] Unknown checkoutRequestId:', parsed.checkoutRequestId);
      return;
    }

    if (transaction.status !== 'pending') return;

    transaction.callbackPayload = req.body;
    transaction.callbackReceivedAt = new Date();
    transaction.resultCode = String(parsed.resultCode);

    if (parsed.success) {
      transaction.status = 'success';
      transaction.mpesaReceiptNumber = parsed.mpesaReceiptNumber;
      transaction.transactionDate = new Date();
      transaction.errorMessage = null;
    } else {
      const code = String(parsed.resultCode);
      if (code === '1032') {
        transaction.status = 'cancelled';
      } else if (code === '1037' || code === '1001') {
        transaction.status = 'timeout';
      } else {
        transaction.status = 'failed';
      }
      transaction.errorMessage = parsed.resultDesc;
    }

    await transaction.save();

    logAudit({
      shopId: transaction.shop,
      action: `mpesa.callback.${transaction.status}`,
      entityType: 'MpesaTransaction',
      entityId: transaction._id,
      details: { resultCode: parsed.resultCode, mpesaReceiptNumber: parsed.mpesaReceiptNumber },
    }).catch(() => {});
  } catch (err) {
    console.error('[M-Pesa Callback] Processing error:', err.message);
  }
};

// New callbacks carry the sale and reserved attempt; old callbacks retain
// provider-reference lookup. Never query on an absent/undefined reference.
function reversalLookup(req, parsed) {
  if (req.params.attemptId) {
    if (!mongoose.isValidObjectId(req.params.saleId)) return null;
    return { _id: req.params.saleId, 'refund.attemptId': req.params.attemptId };
  }
  if (typeof parsed.originatorConversationId === 'string' && parsed.originatorConversationId) return { 'refund.originatorConversationId': parsed.originatorConversationId };
  if (typeof parsed.conversationId === 'string' && parsed.conversationId) return { 'refund.conversationId': parsed.conversationId };
  return null;
}

function reversalMatches(sale, parsed) {
  if (!parsed.originatorConversationId && !parsed.conversationId) return false;
  return ['originatorConversationId', 'conversationId'].every(key =>
    !sale.refund?.[key] || !parsed[key] || sale.refund[key] === parsed[key]);
}

/** Correlate and settle the reserved reversal atomically. */
export const handleReversalResult = async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const parsed = parseReversalResult(req.body);
    if (!/^\d+$/.test(parsed.resultCode)) return;
    const lookup = reversalLookup(req, parsed);
    if (!lookup) return;
    const session = await mongoose.startSession();
    let settled;
    try {
      await session.withTransaction(async () => {
        settled = null;
        const sale = await Sale.findOne({ ...lookup, status: 'refund_pending' }).session(session);
        if (!sale || !reversalMatches(sale, parsed)) return;
        // A supplied amount must match the amount actually sent to Daraja.
        if (parsed.success && parsed.amount != null && Number(parsed.amount) !== Math.ceil(sale.refund.amount)) return;
        if (parsed.success) {
          await restoreSaleStock(sale, session);
          sale.status = 'refunded';
          sale.refund.completedAt = new Date();
          sale.refund.reversalTransactionId = parsed.transactionId;
          sale.refund.failureReason = undefined;
        } else {
          sale.status = 'completed';
          sale.refund.failureReason = parsed.resultDesc || 'The M-Pesa reversal was rejected.';
        }
        if (parsed.originatorConversationId) sale.refund.originatorConversationId = parsed.originatorConversationId;
        if (parsed.conversationId) sale.refund.conversationId = parsed.conversationId;
        sale.refund.resultCode = parsed.resultCode;
        sale.refund.resultDesc = parsed.resultDesc;
        await sale.save({ session });
        settled = sale;
      });
    } finally { await session.endSession(); }
    if (!settled) return;
    logAudit({
      shopId: settled.shop,
      action: parsed.success ? 'sale.refund.completed' : 'sale.refund.failed',
      entityType: 'Sale', entityId: settled._id,
      details: { resultCode: parsed.resultCode, resultDesc: parsed.resultDesc, reversalTransactionId: parsed.transactionId },
    }).catch(() => {});
  } catch (err) {
    console.error('[M-Pesa Reversal] Processing error:', err.message);
  }
};

/** A queue timeout is not proof of a definitive payout outcome. */
export const handleReversalTimeout = async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const parsed = {
      originatorConversationId: req.body?.Result?.OriginatorConversationID ?? req.body?.OriginatorConversationID,
      conversationId: req.body?.Result?.ConversationID ?? req.body?.ConversationID,
    };
    const lookup = reversalLookup(req, parsed);
    if (!lookup) return;
    const sale = await Sale.findOne({ ...lookup, status: 'refund_pending' });
    if (!sale || !reversalMatches(sale, parsed)) return;
    const guard = sale.refund.attemptId
      ? { 'refund.attemptId': sale.refund.attemptId }
      : { 'refund.originatorConversationId': sale.refund.originatorConversationId, 'refund.conversationId': sale.refund.conversationId };
    await Sale.updateOne({ _id: sale._id, status: 'refund_pending', ...guard }, { $set: {
      'refund.failureReason': 'M-Pesa has not confirmed this refund. Check with support before refunding again.',
    } });
  } catch (err) {
    console.error('[M-Pesa Reversal Timeout] Processing error:', err.message);
  }
};

/**
 * Safaricom B2C result callback — the outcome of a payout initiated via
 * POST /internal/b2c/payout (see controllers/internal/b2cController.js).
 * Same ack-first, idempotency-checked shape as handleReversalResult.
 */
export const handleB2CResult = async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const parsed = parseB2CResult(req.body);

    const transaction = await B2CTransaction.findOne({ conversationId: parsed.conversationId });
    if (!transaction) {
      console.error('[M-Pesa B2C] Unknown conversation id:', parsed.conversationId);
      return;
    }
    // Duplicate callback delivery — never process twice.
    if (transaction.status !== 'pending') return;

    transaction.status = parsed.success ? 'completed' : 'failed';
    transaction.resultCode = parsed.resultCode;
    transaction.resultDesc = parsed.resultDesc;
    if (parsed.success) {
      transaction.mpesaReceiptNumber = parsed.mpesaReceiptNumber;
      transaction.transactionCompletedAt = parsed.transactionCompletedAt ? new Date(parsed.transactionCompletedAt) : new Date();
    }
    await transaction.save();

    const delivered = await notifyCommissionPayoutResult({
      reference: transaction.reference,
      status: transaction.status,
      mpesaReceiptNumber: transaction.mpesaReceiptNumber,
      resultDesc: transaction.resultDesc,
    });
    if (delivered) {
      transaction.reconciledAt = new Date();
      await transaction.save();
    }
  } catch (err) {
    console.error('[M-Pesa B2C] Processing error:', err.message);
  }
};

/**
 * Safaricom B2C queue-timeout endpoint — the request never reached the
 * processor. Same shape as handleReversalTimeout.
 */
export const handleB2CTimeout = async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const originatorId = req.body?.Result?.OriginatorConversationID ?? req.body?.OriginatorConversationID;
    if (!originatorId) return;

    const transaction = await B2CTransaction.findOne({ originatorConversationId: originatorId });
    if (!transaction || transaction.status !== 'pending') return;

    transaction.status = 'failed';
    transaction.resultDesc = 'Timed out in Safaricom queue';
    await transaction.save();

    const delivered = await notifyCommissionPayoutResult({
      reference: transaction.reference,
      status: transaction.status,
      resultDesc: transaction.resultDesc,
    });
    if (delivered) {
      transaction.reconciledAt = new Date();
      await transaction.save();
    }
  } catch (err) {
    console.error('[M-Pesa B2C Timeout] Processing error:', err.message);
  }
};

/** Links a completed M-Pesa transaction to a sale after it's been recorded. */
export const linkTransactionToSale = async (transactionId, saleId) => {
  await MpesaTransaction.findByIdAndUpdate(transactionId, { saleId });
};

/**
 * Looks up a transaction by the M-Pesa receipt number the customer received via SMS.
 */
export const verifyByReceipt = async (req, res) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;
    const { receiptNumber } = req.body;

    const transaction = await MpesaTransaction.findOne({
      shop: shopId,
      mpesaReceiptNumber: receiptNumber.trim().toUpperCase(),
    }).populate('requestedBy', 'name email');

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: `No transaction found with M-Pesa receipt ${receiptNumber}. The payment may not have been processed by this shop.`,
      });
    }

    return res.json({
      success: true,
      data: {
        transactionId: transaction._id,
        status: transaction.status,
        mpesaReceiptNumber: transaction.mpesaReceiptNumber,
        phoneNumber: transaction.phoneNumber,
        amount: transaction.amount,
        accountReference: transaction.accountReference,
        saleId: transaction.saleId ?? null,
        transactionDate: transaction.transactionDate ?? null,
        createdAt: transaction.createdAt,
        requestedBy: transaction.requestedBy,
      },
      message: transaction.status === 'success'
        ? 'Payment verified successfully.'
        : `Transaction found but status is "${transaction.status}".`,
    });
  } catch (err) {
    console.error('[M-Pesa Verify] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to verify transaction.' });
  }
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function parseMpesaError(err, environment) {
  const raw = err.message ?? '';

  const jsonMatch = raw.match(/\{.*\}/s);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const sfError = parsed.errorMessage || parsed.ResponseDescription || parsed.errorDescription;
      if (sfError) {
        return buildUserMessage(sfError, raw, environment);
      }
    } catch {
      // JSON parse failed — fall through to generic handling
    }
  }

  if (/oauth/i.test(raw) || /401|400/.test(raw)) {
    return 'M-Pesa credentials are invalid. Please update your Consumer Key and Consumer Secret in Profile → Payments.';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(raw)) {
    return 'Could not reach the M-Pesa API. Check your internet connection and try again.';
  }
  if (/passkey|password/i.test(raw)) {
    return 'M-Pesa Passkey is invalid. Please update it in Profile → Payments.';
  }
  if (/shortcode/i.test(raw)) {
    return 'Invalid M-Pesa Shortcode. Please verify it in Profile → Payments.';
  }

  return `M-Pesa request failed: ${raw}`;
}

function buildUserMessage(sfError, raw, environment) {
  const e = sfError.toLowerCase();
  if (e.includes('authentication') || e.includes('invalid key') || e.includes('consumer')) {
    return `M-Pesa credentials rejected by Safaricom: "${sfError}". Update your Consumer Key and Consumer Secret in Profile → Payments.`;
  }
  if (e.includes('shortcode') || e.includes('business')) {
    return `Safaricom rejected the Shortcode: "${sfError}". Verify your Shortcode in Profile → Payments.`;
  }
  if (e.includes('insufficient') || e.includes('balance')) {
    return `M-Pesa: "${sfError}". The customer may have insufficient balance.`;
  }
  if (environment === 'sandbox' && (e.includes('test') || e.includes('sandbox'))) {
    return `Sandbox M-Pesa: "${sfError}". Use a Safaricom test phone number for sandbox testing.`;
  }
  return `Safaricom error: "${sfError}"`;
}
