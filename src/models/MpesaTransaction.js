import mongoose from 'mongoose';

const mpesaTransactionSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  // Linked after successful payment + sale creation
  saleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
    index: true,
  },
  // Safaricom-assigned identifiers
  checkoutRequestId: { type: String, index: true },
  merchantRequestId: { type: String },
  // Transaction details
  phoneNumber: { type: String, required: true },
  amount: { type: Number, required: true },
  accountReference: { type: String },
  status: {
    type: String,
    enum: ['pending', 'success', 'failed', 'cancelled', 'timeout'],
    default: 'pending',
    index: true,
  },
  // Populated from Safaricom callback on success
  mpesaReceiptNumber: { type: String },
  transactionDate: { type: Date },
  // Error context for failed/cancelled transactions
  resultCode: { type: String },
  errorMessage: { type: String },
  // Raw callback payload for audit trail
  callbackPayload: { type: mongoose.Schema.Types.Mixed },
  callbackReceivedAt: { type: Date },
  // Who initiated the push
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, { timestamps: true });

// TTL: keep failed/cancelled transactions for 90 days; successful ones are permanent
// (No TTL applied — business retains financial records)

export default mongoose.model('MpesaTransaction', mpesaTransactionSchema);
