import Joi from 'joi';
import { METHOD_KEY_PATTERN } from '../constants/salePaymentMethods.js';
import {
  MAX_CREDIT_AMOUNT,
  MAX_COLLECTION_PERIOD_DAYS,
  MAX_CREDIT_LIMIT,
  CREDIT_PRODUCT_POLICIES,
  CREDIT_OVERDUE_POLICIES,
} from '../constants/credit.js';
import { objectId } from './customerValidation.js';

/**
 * Money moving in or out of a debt.
 *
 * `positive()` rejects zero and negatives outright — a zero repayment is a
 * no-op row in a financial ledger and a negative one is an attempt to turn a
 * repayment into a debt. The ceiling bounds overflow abuse; no duka repayment
 * legitimately reaches it.
 */
const amount = Joi.number().positive().max(MAX_CREDIT_AMOUNT).precision(2);

export const recordPaymentSchema = Joi.object({
  amount: amount.required().messages({
    'number.positive': 'Enter an amount greater than zero.',
    'number.max': 'That amount is too large. Check the figure and try again.',
  }),
  // Validated against the shop's own button list in the controller, which is
  // the only layer that can see it — same split as createSaleSchema.
  paymentMethod: Joi.string().trim().lowercase().pattern(METHOD_KEY_PATTERN).required(),
  // M-Pesa code, bank slip, whatever the shop writes down. Never required:
  // cash over the counter has no reference and pretending otherwise would
  // train cashiers to type something meaningless.
  reference: Joi.string().trim().max(60).allow('').optional(),
  note: Joi.string().trim().max(300).allow('').optional(),
}).unknown(false);

export const reverseTransactionSchema = Joi.object({
  // Required, unlike a void's optional reason: reversing a posted financial
  // entry is the one action here whose "why" a lender or an auditor will ask
  // about, and the person doing it is the only one who knows.
  reason: Joi.string().trim().min(3).max(300).required().messages({
    'any.required': 'Say why this entry is being reversed.',
    'string.min': 'Say why this entry is being reversed.',
  }),
}).unknown(false);

export const openingBalanceSchema = Joi.object({
  customerId: objectId.required(),
  amount: amount.required(),
  // The one place a client may supply a due date, because the debt predates
  // this system and only the owner knows when it falls due. Bounded to a
  // sane window so it can't be used to park a debt outside every report, and
  // audit-logged. Everywhere else dueAt is server-generated.
  // Bounded by a custom check rather than Joi.ref('$...'): the shared validate()
  // middleware passes no validation context, so a context ref would silently
  // evaluate to undefined and the bound would never apply.
  dueAt: Joi.date()
    .custom((value, helpers) => {
      const now = Date.now();
      const twoYears = 2 * 365 * 86_400_000;
      if (value.getTime() < now - twoYears) return helpers.message('That due date is too far in the past.');
      if (value.getTime() > now + twoYears) return helpers.message('That due date is too far in the future.');
      return value;
    })
    .optional(),
  // Links this opening balance to the untracked legacy sale it represents, so
  // the same sale can never be imported twice (enforced by a unique index).
  saleId: objectId.optional(),
  note: Joi.string().trim().max(300).allow('').optional(),
}).unknown(false);

export const creditTransactionQuerySchema = Joi.object({
  customerId: objectId,
  type: Joi.string().valid(
    'CREDIT_SALE',
    'CREDIT_PAYMENT',
    'CREDIT_SALE_REVERSAL',
    'CREDIT_PAYMENT_REVERSAL',
    'CREDIT_OPENING_BALANCE',
  ),
  status: Joi.string().valid('outstanding', 'paid', 'reversed'),
  overdueOnly: Joi.boolean().default(false),
  startDate: Joi.date(),
  endDate: Joi.date(),
  // Owners and view_all_credit holders only — silently ignored for anyone
  // whose scope is already pinned to themselves (see ledgerScopeFor).
  staffId: objectId,
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
}).unknown(false);

export const untrackedSalesQuerySchema = Joi.object({
  search: Joi.string().trim().max(60).allow(''),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
}).unknown(false);

/**
 * The shop's credit configuration, folded into updateShopConfigSchema.
 *
 * Every field optional: the Settings screen writes one switch at a time, the
 * way useShopConfigToggle already does for every other shop flag.
 */
export const creditSettingsSchema = Joi.object({
  enabled: Joi.boolean(),
  defaultCreditLimit: Joi.number().min(0).max(MAX_CREDIT_LIMIT).precision(2),
  defaultCollectionPeriodDays: Joi.number().integer().min(0).max(MAX_COLLECTION_PERIOD_DAYS),
  productPolicy: Joi.string().valid(...CREDIT_PRODUCT_POLICIES),
  overduePolicy: Joi.string().valid(...CREDIT_OVERDUE_POLICIES),
}).unknown(false).min(1);
