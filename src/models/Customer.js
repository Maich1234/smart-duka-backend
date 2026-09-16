import mongoose from 'mongoose';
import { MAX_CREDIT_LIMIT } from '../constants/credit.js';

/**
 * A customer of one shop, and that shop's credit account for them.
 *
 * There is no separate CustomerCreditAccount collection on purpose. A customer
 * record here is already scoped to exactly one shop — the same person shopping
 * at two dukas is two independent records, which is both the privacy story
 * ("a customer of Shop A is never reachable from Shop B") and the accounting
 * story (two shops extend two unrelated debts). A second collection keyed
 * (shop, customer) would therefore hold one row per customer forever, at the
 * cost of a join on every read and a second document to keep consistent under
 * concurrency. The account fields live here, grouped under `credit`.
 *
 * The figures in `credit` are a *rollup*, never the source of truth: every
 * shilling is recorded as an immutable CreditTransaction, and these fields are
 * derived from them. They exist because the alternative — aggregating a
 * customer's whole ledger on every till lookup and every list row — cannot be
 * made atomic, and the credit-limit check has to be atomic. See creditService.
 */
const customerSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: [true, 'Customer name is required'],
    trim: true,
    maxlength: 120,
  },
  // Not unique: a duka has two Mary Wanjikus, and plenty of customers share a
  // family phone. Uniqueness would reject a legitimate record at the counter.
  phone: {
    type: String,
    trim: true,
    default: '',
    maxlength: 20,
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    default: '',
  },
  notes: {
    type: String,
    trim: true,
    default: '',
    maxlength: 500,
  },
  // Soft-delete, same reasoning as Supplier.isActive: a customer is referenced
  // by sales and by a debt ledger, so removing them from the picker must never
  // make a historical record unreadable. A customer who still owes money
  // cannot be archived at all (enforced in the controller).
  isActive: {
    type: Boolean,
    default: true,
  },
  credit: {
    // null = follow the shop's defaultCreditLimit. Stored as null rather than
    // a copied number so raising the shop-wide limit lifts everyone who was
    // never given a bespoke one.
    limit: {
      type: Number,
      default: null,
      min: 0,
      max: MAX_CREDIT_LIMIT,
    },
    // Owner-set bar on this specific customer, independent of their balance.
    // Survives a full repayment — being square is not the same as being
    // trusted again.
    blocked: {
      type: Boolean,
      default: false,
    },
    blockedReason: { type: String, trim: true, maxlength: 200, default: '' },
    // Sum of CREDIT_SALE.outstanding across this customer's open debts.
    // Guarded on write by a conditional update; never assigned from a client.
    outstanding: { type: Number, default: 0, min: 0 },
    // The portion of `outstanding` whose dueAt has already passed.
    overdueAmount: { type: Number, default: 0, min: 0 },
    // Earliest dueAt among still-unpaid debts, null when square. This is what
    // makes "is this customer overdue?" answerable at the instant of a sale
    // rather than only after the nightly sweep has run.
    oldestDueAt: { type: Date, default: null },
    // Denormalized for list filters (All / Outstanding / Overdue / Paid).
    // 'none' = never took credit; 'paid' = took credit and cleared it.
    status: {
      type: String,
      enum: ['none', 'current', 'overdue', 'paid'],
      default: 'none',
    },
    // Lifetime totals — the account screen's "has been good for it" signal.
    totalExtended: { type: Number, default: 0, min: 0 },
    totalRepaid: { type: Number, default: 0, min: 0 },
    lastSaleAt: { type: Date, default: null },
    lastPaymentAt: { type: Date, default: null },
  },
}, {
  timestamps: true,
});

// Hot path: the customer picker at the till and the Customers list are always
// "this shop, alphabetical".
customerSchema.index({ shop: 1, name: 1 });
// Lookup by phone at the counter ("the number ends 4457").
customerSchema.index({ shop: 1, phone: 1 }, { sparse: true });
// The Credit section's list filters and its "who owes the most" ordering.
customerSchema.index({ shop: 1, 'credit.status': 1, 'credit.outstanding': -1 });
// The overdue sweep scans by due date across shops.
customerSchema.index({ 'credit.oldestDueAt': 1 }, { sparse: true });

export default mongoose.model('Customer', customerSchema);
