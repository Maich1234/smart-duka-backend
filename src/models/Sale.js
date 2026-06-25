import mongoose from 'mongoose';

const saleItemSchema = new mongoose.Schema({
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
    // Weighted/refillable items can be sold in fractional amounts (e.g. 0.5 kg);
    // whole-unit enforcement for standard/service/bundle/variable/configurable
    // items happens in pricingEngine.js, not here.
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
  },
  discountAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  appliedPromotionLabel: {
    type: String,
  },
  // Snapshot fields — optional, only populated for the product types that need them.
  variantId: {
    type: mongoose.Schema.Types.ObjectId,
  },
  variantName: {
    type: String,
  },
  unitOfMeasure: {
    type: String,
  },
  productType: {
    type: String,
  },
});

const saleSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  invoiceNumber: {
    type: String,
    unique: true,
  },
  items: [saleItemSchema],
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'mpesa', 'card'],
    required: true,
  },
  // Populated for M-Pesa sales — links to the confirmed STK Push transaction
  mpesaTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MpesaTransaction',
  },
  mpesaReceiptNumber: {
    type: String,
  },
  staff: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
});

saleSchema.pre('save', async function (next) {
  if (!this.invoiceNumber) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const count = await mongoose.model('Sale').countDocuments({ shop: this.shop });
    this.invoiceNumber = `INV-${year}${month}-${(count + 1).toString().padStart(5, '0')}`;
  }
  next();
});

export default mongoose.model('Sale', saleSchema);