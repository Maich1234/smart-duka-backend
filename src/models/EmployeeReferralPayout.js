import mongoose from 'mongoose';

// A cash bonus owed to a staff member for referring a shop that went on to
// subscribe — created once, at the referred shop's first successful
// subscription payment (see subscriptionController.js's referral-reward
// block), then moved to 'paid' or 'cancelled' by a platform admin from
// dukana-admin-backend's /referral-payouts endpoints (via the secondary
// connection). Deliberately a two-transition ledger (pending→paid,
// pending→cancelled) — payment itself happens outside the app, this is only
// the record of what's owed and whether it's been settled.
const employeeReferralPayoutSchema = new mongoose.Schema({
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  // One payout per referred shop, ever — guards against double-granting if
  // the referral-reward block is ever re-run for the same conversion.
  referredShopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, unique: true },
  // Snapshot of PlatformConfig.referral.employee.cashAmount at grant time —
  // a later change to the configured amount never rewrites history.
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'KES', uppercase: true, trim: true },
  status: {
    type: String,
    enum: ['pending', 'paid', 'cancelled'],
    default: 'pending',
    index: true,
  },
  // No `ref` — AdminUser lives in the admin backend's own database.
  paidBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  paidAt: { type: Date, default: null },
  cancelledReason: { type: String, default: '', trim: true },
}, { timestamps: true });

export default mongoose.model('EmployeeReferralPayout', employeeReferralPayoutSchema);
