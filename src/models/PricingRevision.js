import mongoose from 'mongoose';

// One durable marker per rollout, with plan-only snapshots for support review.
// No shop/customer/payment records are stored here or rewritten by a revision.
const pricingRevisionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  appliedAt: { type: Date, default: Date.now },
  plansBefore: { type: [mongoose.Schema.Types.Mixed], default: [] },
  plansAfter: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { versionKey: false });
export default mongoose.model('PricingRevision', pricingRevisionSchema);
