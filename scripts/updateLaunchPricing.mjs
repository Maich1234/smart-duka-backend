/** Run once after deploying the schema/engine. Preview by default; --apply writes.
 * Existing plan IDs, entitlements, subscriptions and historical payments stay intact. */
import 'dotenv/config';
import mongoose from 'mongoose';
import SubscriptionPlan from '../src/models/SubscriptionPlan.js';
import { DEFAULT_PLANS } from '../src/constants/subscriptionDefaults.js';

const apply = process.argv.includes('--apply');
if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required. No changes made.');
try {
  await mongoose.connect(process.env.MONGO_URI);
  for (const plan of DEFAULT_PLANS) {
    const existing = await SubscriptionPlan.findOne({ slug: plan.slug }).lean();
    const pricing = Object.fromEntries(['billingType', 'monthlyPrice', 'monthlyCharge', 'minUsers', 'maxStaff', 'unlimitedUsers', 'overflowTiers', 'extraStaffPrice', 'displayOrder', 'priceComparison', 'active', 'currency', 'quarterlyDiscountPercent', 'yearlyDiscountPercent'].map(key => [key, plan[key] ?? (key === 'overflowTiers' ? [] : false)]));
    pricing.yearlyPrice = null;
    if (existing) {
      pricing.highlights = (existing.highlights ?? []).map(text => /^Supports up to \d+ (staff|users)/i.test(text) ? (plan.unlimitedUsers ? '9 or more shop users' : `Up to ${plan.maxStaff} shop users`) : text);
    }
    console.log(JSON.stringify({ slug: plan.slug, action: existing ? 'update pricing' : 'create plan', monthlyBase: pricing.monthlyPrice, monthlyCharge: pricing.monthlyCharge, total: pricing.monthlyPrice + pricing.monthlyCharge, minUsers: pricing.minUsers, maxUsers: pricing.unlimitedUsers ? null : pricing.maxStaff, applied: apply }));
    if (apply) {
      if (existing) await SubscriptionPlan.updateOne({ _id: existing._id }, { $set: pricing }, { runValidators: true });
      else await SubscriptionPlan.create({ ...plan, ...pricing });
    }
  }
} finally { await mongoose.disconnect(); }
