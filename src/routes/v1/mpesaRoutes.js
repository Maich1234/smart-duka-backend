import express from 'express';
import { protect, staffOrOwner, ownerOnly } from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import {
  initiatePayment,
  getTransactionStatus,
  handleCallback,
  handleReversalResult,
  handleReversalTimeout,
  verifyByReceipt,
} from '../../controllers/mpesaController.js';
import {
  getPaymentTransactions,
  getPaymentTransactionById,
} from '../../controllers/paymentTransactionController.js';
import { initiateSTKPushSchema, verifyReceiptSchema, transactionQuerySchema } from '../../validations/mpesaValidation.js';

const router = express.Router();

// Safaricom sends the callback here — must be publicly accessible (no JWT auth)
router.post('/callback', handleCallback);

// Transaction Reversal (refund) result + queue-timeout callbacks — also public
router.post('/reversal-result', handleReversalResult);
router.post('/reversal-result-timeout', handleReversalTimeout);

// Staff can initiate STK Push during checkout
router.post('/initiate', protect, staffOrOwner, validate(initiateSTKPushSchema), initiatePayment);

// Poll transaction status (staff can poll their own, owners can poll any)
router.get('/status/:transactionId', protect, staffOrOwner, getTransactionStatus);

// Verify a payment by the M-Pesa receipt number shown on the customer's phone
router.post('/verify-receipt', protect, staffOrOwner, validate(verifyReceiptSchema), verifyByReceipt);

// Transaction history — owner only
router.get('/transactions', protect, ownerOnly, validate(transactionQuerySchema, 'query'), getPaymentTransactions);
router.get('/transactions/:id', protect, ownerOnly, getPaymentTransactionById);

export default router;
