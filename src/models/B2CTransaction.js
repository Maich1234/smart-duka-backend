import mongoose from 'mongoose';

// One document per B2C payout attempt (currently: agent commission payouts
// initiated from dukana-admin-backend). Lives in this DB — the only service
// holding Daraja credentials — and is looked up cross-DB (getSmartDukaModels)
// by dukana-admin-backend's reconciliation cron as a backstop for the primary
// path, which pushes the result there directly as soon as it's known.
// `reference` is deliberately opaque (a CommissionRecord._id as a string,
// no ref) — this collection doesn't know or care what it's paying for.
const b2cTransactionSchema = new mongoose.Schema({
  conversationId: { type: String, required: true, unique: true },
  originatorConversationId: { type: String, index: true },
  reference: { type: String, required: true, index: true },
  phoneNumber: { type: String, required: true },
  amount: { type: Number, required: true },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending',
    index: true,
  },
  resultCode: { type: String },
  resultDesc: { type: String },
  mpesaReceiptNumber: { type: String },
  transactionCompletedAt: { type: Date },
  // Set once the result has been successfully pushed to (or picked up by)
  // dukana-admin-backend, so the backstop cron never reprocesses it.
  reconciledAt: { type: Date, default: null },
}, { timestamps: true });

export default mongoose.model('B2CTransaction', b2cTransactionSchema);
