import mongoose from 'mongoose';
import { nextQuoteNumber } from '../services/quoteNumberService.js';

const quotationItemSchema = new mongoose.Schema({
  // Present for a catalog line, absent for a free-text custom line — same
  // optionality this feature introduces on Sale.items.productId, and for the
  // same reason.
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    trim: true,
    maxlength: 300,
    default: '',
  },
  quantity: {
    type: Number,
    required: true,
    min: 0.001,
  },
  unitPrice: {
    type: Number,
    required: true,
    min: 0,
  },
  subtotal: {
    type: Number,
    required: true,
    min: 0,
  },
}, { _id: false });

const quotationSchema = new mongoose.Schema({
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
  // Captured at creation time so a later edit to the Customer record (a
  // rename, a corrected phone number) never rewrites a quotation already
  // shared with someone.
  customerSnapshot: {
    name: { type: String, required: true },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
  },
  quoteNumber: {
    type: String,
    required: true,
  },
  items: {
    type: [quotationItemSchema],
    validate: {
      validator: (v) => Array.isArray(v) && v.length > 0,
      message: 'A quotation needs at least one line item.',
    },
  },
  subtotal: { type: Number, required: true, min: 0 },
  taxRate: { type: Number, default: 0, min: 0 },
  taxAmount: { type: Number, default: 0, min: 0 },
  total: { type: Number, required: true, min: 0 },
  notes: { type: String, trim: true, maxlength: 500, default: '' },
  validUntil: { type: Date, required: true },
  status: {
    type: String,
    enum: ['draft', 'declined', 'converted'],
    default: 'draft',
  },
  convertedSale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
    default: null,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdByName: { type: String, required: true },
}, {
  timestamps: true,
});

// List screen: this shop, newest first.
quotationSchema.index({ shop: 1, createdAt: -1 });
// Status filter tabs (draft / declined / converted).
quotationSchema.index({ shop: 1, status: 1, createdAt: -1 });
// Per-shop, not global — same reasoning as Sale.invoiceNumber.
quotationSchema.index({ shop: 1, quoteNumber: 1 }, { unique: true });

// Runs inside the caller's session when there is one, same as Sale's
// pre-save hook — see quoteNumberService.js for why that matters.
quotationSchema.pre('save', async function assignQuoteNumber(next) {
  if (!this.isNew || this.quoteNumber) return next();

  try {
    this.quoteNumber = await nextQuoteNumber(this.shop, {
      ShopModel: mongoose.model('Shop'),
      session: this.$session(),
    });
    return next();
  } catch (error) {
    return next(error);
  }
});

export default mongoose.model('Quotation', quotationSchema);
