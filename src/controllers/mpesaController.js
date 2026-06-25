import PaymentConfig from '../models/PaymentConfig.js';
import MpesaTransaction from '../models/MpesaTransaction.js';
import { initiateSTKPush, parseSTKCallback, normalizeKenyanPhone } from '../services/mpesaService.js';
import { logAudit } from '../services/auditLogService.js';

const CALLBACK_URL = process.env.MPESA_CALLBACK_URL || `${process.env.API_BASE_URL}/api/v1/mpesa/callback`;

/** Sends an STK Push to the customer's phone and creates a pending transaction record. */
export const initiatePayment = async (req, res) => {
  const shopId = req.user.shop._id ?? req.user.shop;
  const { phoneNumber, amount, accountReference } = req.body;

  const paymentConfig = await PaymentConfig.findOne({ shop: shopId });
  if (!paymentConfig?.mpesa?.enabled || !paymentConfig?.mpesa?.consumerKey) {
    return res.status(400).json({
      success: false,
      message: 'M-Pesa is not configured for this shop. Please connect your M-Pesa Business account in Settings.',
    });
  }

  const mpesaConfig = paymentConfig.mpesa;

  let stkResult;
  try {
    stkResult = await initiateSTKPush({
      config: mpesaConfig,
      phoneNumber,
      amount,
      accountReference: accountReference || 'SmartDuka',
      transactionDesc: 'Sale Payment',
      callbackUrl: CALLBACK_URL,
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      message: `M-Pesa request failed: ${err.message}`,
    });
  }

  const transaction = await MpesaTransaction.create({
    shop: shopId,
    checkoutRequestId: stkResult.checkoutRequestId,
    merchantRequestId: stkResult.merchantRequestId,
    phoneNumber: normalizeKenyanPhone(phoneNumber),
    amount,
    accountReference,
    status: 'pending',
    requestedBy: req.user._id,
  });

  await logAudit({
    shopId,
    userId: req.user._id,
    action: 'mpesa.stk_push.initiated',
    entityType: 'MpesaTransaction',
    entityId: transaction._id,
    details: { phoneNumber: normalizeKenyanPhone(phoneNumber), amount },
    req,
  });

  res.status(201).json({
    success: true,
    data: {
      transactionId: transaction._id,
      checkoutRequestId: stkResult.checkoutRequestId,
      status: 'pending',
    },
    message: 'Payment request sent to customer.',
  });
};

/** Polls the current status of a pending M-Pesa transaction. */
export const getTransactionStatus = async (req, res) => {
  const shopId = req.user.shop._id ?? req.user.shop;
  const { transactionId } = req.params;

  const transaction = await MpesaTransaction.findOne({ _id: transactionId, shop: shopId });
  if (!transaction) {
    return res.status(404).json({ success: false, message: 'Transaction not found' });
  }

  // If still pending and callback hasn't arrived, check for timeout (> 2 minutes)
  if (transaction.status === 'pending') {
    const ageMs = Date.now() - new Date(transaction.createdAt).getTime();
    if (ageMs > 2 * 60 * 1000) {
      transaction.status = 'timeout';
      await transaction.save();
    }
  }

  res.json({
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
};

/**
 * Safaricom STK Push callback endpoint — publicly accessible, no JWT auth.
 * Validates, updates the transaction record, and prevents duplicate processing.
 */
export const handleCallback = async (req, res) => {
  // Acknowledge immediately — Safaricom expects a 200 within a few seconds
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

    // Idempotency guard — don't reprocess a finalised transaction
    if (transaction.status !== 'pending') return;

    transaction.callbackPayload = req.body;
    transaction.callbackReceivedAt = new Date();
    transaction.resultCode = parsed.resultCode;

    if (parsed.success) {
      transaction.status = 'success';
      transaction.mpesaReceiptNumber = parsed.mpesaReceiptNumber;
      transaction.transactionDate = new Date();
      transaction.errorMessage = null;
    } else {
      // ResultCode 1032 = cancelled by user, 1037 = timeout
      if (['1032'].includes(parsed.resultCode)) {
        transaction.status = 'cancelled';
      } else if (['1037', '1001'].includes(parsed.resultCode)) {
        transaction.status = 'timeout';
      } else {
        transaction.status = 'failed';
      }
      transaction.errorMessage = parsed.resultDesc;
    }

    await transaction.save();

    await logAudit({
      shopId: transaction.shop,
      action: `mpesa.callback.${transaction.status}`,
      entityType: 'MpesaTransaction',
      entityId: transaction._id,
      details: { resultCode: parsed.resultCode, mpesaReceiptNumber: parsed.mpesaReceiptNumber },
    });
  } catch (err) {
    console.error('[M-Pesa Callback] Processing error:', err.message);
  }
};

/** Links a completed M-Pesa transaction to a sale after it's been recorded. */
export const linkTransactionToSale = async (transactionId, saleId) => {
  await MpesaTransaction.findByIdAndUpdate(transactionId, { saleId });
};
