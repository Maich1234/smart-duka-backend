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
  // Idempotency key sent by client to deduplicate retried requests
  idempotencyKey: { type: String, index: true },
}, { timestamps: true });

// Unique idempotency key per shop — sparse so documents without the key are not constrained
mpesaTransactionSchema.index({ shop: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

export default mongoose.model('MpesaTransaction', mpesaTransactionSchema);
