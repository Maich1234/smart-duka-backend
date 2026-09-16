import mongoose from 'mongoose';
import { CREDIT_TX_TYPES, MAX_CREDIT_AMOUNT } from '../constants/credit.js';

/**
 * One immutable line in a customer's debt ledger.
 *
 * Debt is not a number someone edits. Every movement — a sale taken on
 * account, a repayment, a correction — is a row here, and the balance on the
 * Customer document is the running total of these rows. A mistake is fixed by
 * writing a compensating row (CREDIT_SALE_REVERSAL / CREDIT_PAYMENT_REVERSAL)
 * that points back at what it reverses, never by rewriting history: an owner
 * showing a lender "you can see every shilling and who recorded it" is the
 * whole point of keeping a ledger instead of a balance.
 *
 * Nothing in the API updates a row's money fields after creation. The two
 * fields that do change are bookkeeping on a CREDIT_SALE — `outstanding` as
 * repayments are allocated against it, and `status`/`overdueAt` as it settles
 * or falls due — both driven by other immutable rows.
 */
const allocationSchema = new mongoose.Schema({
  // The CREDIT_SALE this slice of the payment was applied to.
  transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditTransaction', required: true },
  amount: { type: Number, required: true, min: 0 },
}, { _id: false });

const creditTransactionSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true,
  },
  type: {
    type: String,
    enum: Object.values(CREDIT_TX_TYPES),
    required: true,
  },
  // Always positive. Direction comes from `type` (see CREDIT_TX_SIGN), so a
  // sign error in a client can never turn a debt into a credit.
  amount: {
    type: Number,
    required: true,
    min: 0.01,
    max: MAX_CREDIT_AMOUNT,
  },
  // Customer's total outstanding immediately after this row was written.
  // Snapshotted so a statement can be reconstructed without replaying the
  // whole ledger, and so a drifted rollup is visible rather than silent.
  balanceAfter: { type: Number, required: true, min: 0 },

  // ── Debt rows (CREDIT_SALE, CREDIT_OPENING_BALANCE) only ──────────────
  // How much of THIS debt is still unpaid. Repayments are allocated oldest
  // first, so aging and overdue are per-debt facts, not a single balance with
  // one date attached.
  outstanding: { type: Number, default: 0, min: 0 },
  // The actual due date, computed once from the settings in force at the time
  // of sale. Never recomputed: changing the shop's collection period must not
  // move a debt the customer already agreed to.
  dueAt: { type: Date },
  status: {
    type: String,
    enum: ['outstanding', 'paid', 'reversed'],
  },
  // Set by the overdue sweep the first time this debt is found past due, and
  // cleared if it is later settled. Its presence is also the sweep's own
  // dedupe signal, alongside NotificationLog.
  overdueAt: { type: Date, default: null },
  // The sale this debt came from — the line items, the receipt, the cashier.
  sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },

  // ── CREDIT_PAYMENT only ───────────────────────────────────────────────
  // A key from the shop's own payment-method list — the same vocabulary a
  // sale uses, so a repayment lands in reconciliation like any other money in.
  paymentMethod: { type: String, trim: true, lowercase: true },
  paymentMethodLabel: { type: String, trim: true },
  // M-Pesa code, bank slip number, whatever the shop writes down.
  reference: { type: String, trim: true, maxlength: 60, default: '' },
  allocations: { type: [allocationSchema], default: undefined },

  // ── CREDIT_OPENING_BALANCE only ───────────────────────────────────────
  // The owner's own note on where this brought-forward debt came from
  // ("chalkboard, Aug 2026"). Lives in `reason`, shared with reversals.

  // ── Reversals ─────────────────────────────────────────────────────────
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditTransaction', default: null },
  // Set on the row being reversed, so a reversed entry is obvious in a
  // timeline without a second lookup.
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditTransaction', default: null },
  reason: { type: String, trim: true, maxlength: 300, default: '' },

  // ── Audit ─────────────────────────────────────────────────────────────
  // Who did this. Required: an unattributed financial record is not a record.
  staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  staffName: { type: String, trim: true },
  // The work session, when the shop runs shifts — mirrors Sale.shift so a
  // repayment taken in cash reconciles against the drawer it went into.
  shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
  // The client's idempotency key for the request that created this row.
  // Unique per shop, so a retried repayment can never be booked twice even if
  // the IdempotencyRecord for it has aged out of its 72h window.
  clientRef: { type: String, default: null },
}, {
  timestamps: true,
  versionKey: false,
});

// The customer account timeline.
creditTransactionSchema.index({ shop: 1, customer: 1, createdAt: -1 });
// "Credit I gave" — a staff member with view_own_credit is served by the
// database, never by filtering a full download on the device.
creditTransactionSchema.index({ shop: 1, staff: 1, createdAt: -1 });
// The overdue sweep: open debts, oldest due first.
creditTransactionSchema.index({ status: 1, dueAt: 1 }, { sparse: true });
// Shop-scoped credit list and its status filters.
creditTransactionSchema.index({ shop: 1, type: 1, status: 1, dueAt: 1 });
// A credit sale is looked up by its sale when voiding or refunding.
//
// Unique, not merely indexed: it is the database-level guarantee that one sale
// can produce at most one debt. Two racing createSale retries carrying
// different idempotency keys, or an owner importing the same legacy sale as an
// opening balance twice, both land here and the second one fails outright
// rather than doubling what the customer owes. Partial rather than sparse so
// the constraint applies only to rows that actually reference a sale.
creditTransactionSchema.index(
  { sale: 1 },
  { unique: true, partialFilterExpression: { sale: { $type: 'objectId' } } },
);
// Idempotency backstop. Partial rather than sparse: two rows may legitimately
// carry no clientRef (a reversal, an older record), and a plain sparse unique
// index would still collide on null in some driver/server combinations.
creditTransactionSchema.index(
  { shop: 1, clientRef: 1 },
  { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } } },
);

export default mongoose.model('CreditTransaction', creditTransactionSchema);
