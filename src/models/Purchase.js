import mongoose from 'mongoose';
import { MONEY_OUT_METHODS } from '../constants/paymentMethods.js';

// Fixed category list, mirroring EXPENSE_CATEGORY_VALUES's export pattern —
// these are costs of *acquiring* stock (transport, packaging, etc.) and are
// deliberately kept separate from the general Expense model/collection.
const PURCHASE_COST_CATEGORIES = [
  'transport', 'delivery', 'fuel', 'loading', 'offloading',
  'packaging', 'market_fee', 'brokerage', 'insurance', 'other',
];

const ALLOCATION_METHODS = ['quantity', 'value', 'none'];

const purchaseItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  productName: {
    type: String,
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 0.001,
  },
  unitCost: {
    type: Number,
    required: true,
    min: 0,
  },
  // Stored explicitly rather than derived on read — quantity*unitCost at the
  // moment of purchase is a historical fact and must never drift if rounding
  // rules change later.
  totalCost: {
    type: Number,
    required: true,
    min: 0,
  },
  // Snapshot fields — optional, only populated for configurable products.
  variantId: {
    type: mongoose.Schema.Types.ObjectId,
  },
  variantName: {
    type: String,
  },
  unitOfMeasure: {
    type: String,
  },
});

// Additional acquisition costs (transport, packaging, ...) attached to a
// purchase. Embedded — not a standalone collection — so a purchase created
// offline (items + costs together) is always a single atomic write; a
// separate collection would need a server-issued Purchase _id before costs
// could reference it, which an offline-queued client doesn't have yet.
const purchaseCostSchema = new mongoose.Schema({
  category: {
    type: String,
    enum: PURCHASE_COST_CATEGORIES,
    required: [true, 'Cost category is required'],
  },
  description: {
    type: String,
    trim: true,
    default: '',
  },
  amount: {
    type: Number,
    required: [true, 'Cost amount is required'],
    min: 0,
  },
  notes: {
    type: String,
    trim: true,
    default: '',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
});

const purchaseSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  // Optional — a purchase can be recorded without a supplier ("walk-in" /
  // "continue without supplier"). `supplierName` snapshots whatever name was
  // shown at recording time (the supplier's name, or a manual walk-in label)
  // so history reads correctly even if the supplier is later renamed/deactivated.
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
  },
  supplierName: {
    type: String,
    trim: true,
    default: '',
  },
  items: [purchaseItemSchema],
  additionalCosts: [purchaseCostSchema],
  // Stored snapshots — never recomputed from items/additionalCosts on read,
  // so a purchase's headline numbers never silently drift.
  productsTotal: {
    type: Number,
    required: true,
    min: 0,
  },
  additionalCostsTotal: {
    type: Number,
    default: 0,
    min: 0,
  },
  grandTotal: {
    type: Number,
    required: true,
    min: 0,
  },
  // How the supplier was paid. 'credit' means nothing left the till — the
  // stock arrived on account — so the Cashbook must skip these entirely rather
  // than book cash that never moved. Settlement is not tracked yet; it arrives
  // with the Creditors book (see docs/business-books.md §6).
  //
  // Defaults to 'cash' to keep every existing purchase and every offline-queued
  // payload valid.
  paymentMethod: {
    type: String,
    enum: MONEY_OUT_METHODS,
    default: 'cash',
  },
  // Snapshot of the shop's cost-allocation default at creation time — if the
  // owner changes the shop default later, past purchases keep the method that
  // actually drove their recorded product-cost updates.
  allocationMethod: {
    type: String,
    enum: ALLOCATION_METHODS,
    default: 'none',
  },
  // 'pending_approval': staff has `require_purchase_approval` — stock/cost
  // are not touched until an owner approves. 'cancelled': soft-deleted (stock
  // impact best-effort reversed, record kept for history).
  status: {
    type: String,
    enum: ['completed', 'pending_approval', 'cancelled'],
    default: 'completed',
  },
  // True once this purchase has actually moved stock/cost — false while
  // pending approval, and reset to false when cancelled.
  inventoryUpdated: {
    type: Boolean,
    default: false,
  },
  staff: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  purchaseDate: {
    type: Date,
    default: Date.now,
  },
  cancelledAt: { type: Date },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, {
  timestamps: true,
});

// Hot paths: shop-scoped date-sorted history, per-supplier and per-staff filters.
purchaseSchema.index({ shop: 1, createdAt: -1 });
purchaseSchema.index({ shop: 1, supplier: 1, createdAt: -1 });
purchaseSchema.index({ shop: 1, staff: 1, createdAt: -1 });
purchaseSchema.index({ shop: 1, status: 1 });

export const PURCHASE_COST_CATEGORY_VALUES = PURCHASE_COST_CATEGORIES;
export const PURCHASE_ALLOCATION_METHOD_VALUES = ALLOCATION_METHODS;
export default mongoose.model('Purchase', purchaseSchema);
