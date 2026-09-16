import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  getCreditOverview,
  getCreditTransactions,
  recordCreditPayment,
  reverseCreditTransaction,
  getUntrackedCreditSales,
  recordOpeningBalance,
} from '../../controllers/creditController.js';
import { protect, staffOrOwner, ownerOnly } from '../../middlewares/auth.js';
import { requirePaidShop } from '../../middlewares/requirePaidShop.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import { createRateLimitStore } from '../../utils/rateLimitStore.js';
import {
  recordPaymentSchema,
  reverseTransactionSchema,
  openingBalanceSchema,
  creditTransactionQuerySchema,
  untrackedSalesQuerySchema,
} from '../../validations/creditValidation.js';

const router = express.Router();

/**
 * Money-moving credit writes.
 *
 * Idempotency already stops an honest client retrying itself into a double
 * repayment; this caps how fast a compromised or buggy one can post distinct
 * entries. Generous enough that a busy collection round never touches it — a
 * cashier taking 60 repayments in 15 minutes is not a real shift.
 */
const creditWriteLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 15 * 60 * 1000,
  max: 60,
  store: createRateLimitStore('credit-write'),
  message: { success: false, message: 'Too many credit entries in a short time. Please wait a moment and try again.' },
});

router.use(protect);

// ── Reads ────────────────────────────────────────────────────────────────
// Deliberately not behind requirePaidShop: a locked shop must always be able
// to see what it is owed, matching the read-only exemption that middleware
// already documents.
router.get('/overview', staffOrOwner, getCreditOverview);
router.get('/transactions', staffOrOwner, validate(creditTransactionQuerySchema, 'query'), getCreditTransactions);
router.get('/untracked-sales', ownerOnly, validate(untrackedSalesQuerySchema, 'query'), getUntrackedCreditSales);

// ── Writes ───────────────────────────────────────────────────────────────
// Repayments are NOT gated on the credit module being enabled — a shop that
// stops lending still has to collect. They are gated on the subscription, like
// every other transactional write.
router.post(
  '/customers/:id/payments',
  staffOrOwner,
  requirePaidShop,
  creditWriteLimiter,
  idempotency,
  validate(recordPaymentSchema),
  recordCreditPayment,
);
// Corrections and opening balances are owner-only at the route as well as in
// the handler — defence in depth on the two endpoints that can move a balance
// without a sale behind it.
router.post(
  '/transactions/:id/reverse',
  ownerOnly,
  requirePaidShop,
  creditWriteLimiter,
  idempotency,
  validate(reverseTransactionSchema),
  reverseCreditTransaction,
);
router.post(
  '/opening-balances',
  ownerOnly,
  requirePaidShop,
  creditWriteLimiter,
  idempotency,
  validate(openingBalanceSchema),
  recordOpeningBalance,
);

export default router;
