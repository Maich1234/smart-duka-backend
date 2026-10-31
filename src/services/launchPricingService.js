import mongoose from 'mongoose';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import PricingRevision from '../models/PricingRevision.js';
import { DEFAULT_PLANS } from '../constants/subscriptionDefaults.js';

export const LAUNCH_PRICING_REVISION = 'shop-user-bands-2026-10-30';
const PRICING_FIELDS = [
  'billingType', 'monthlyPrice', 'monthlyCharge', 'minUsers', 'maxStaff',
  'unlimitedUsers', 'overflowTiers', 'extraStaffPrice', 'displayOrder',
  'priceComparison', 'active', 'currency', 'quarterlyDiscountPercent', 'yearlyDiscountPercent',
];
let ready = false;
let inFlight = null;

async function applyRevision() {
  // A durable marker prevents a new cold start from overwriting later admin edits.
  if (await PricingRevision.exists({ _id: LAUNCH_PRICING_REVISION })) return;
  // Preview and production may share a database. A PR preview must never
  // apply a production price change before its rollout is approved.
  if (process.env.VERCEL_ENV === 'preview') {
    throw new Error('Launch pricing has not been applied in production. Preview cannot update shared plans.');
  }
  // Initialize collections before opening the transaction, including on empty DBs.
  await Promise.all([SubscriptionPlan.init(), PricingRevision.init()]);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (await PricingRevision.exists({ _id: LAUNCH_PRICING_REVISION }).session(session)) return;
      const slugs = DEFAULT_PLANS.map(plan => plan.slug);
      const before = await SubscriptionPlan.find({ slug: { $in: slugs } }).session(session).lean();
      for (const plan of DEFAULT_PLANS) {
        const existing = before.find(row => row.slug === plan.slug);
        const pricing = Object.fromEntries(PRICING_FIELDS.map(key => [key,
          plan[key] ?? (key === 'overflowTiers' ? [] : key === 'unlimitedUsers' ? false : null),
        ]));
        pricing.yearlyPrice = null;
        if (existing) {
          pricing.highlights = (existing.highlights ?? []).map(text => /^Supports up to \d+ (staff|users)/i.test(text)
            ? plan.unlimitedUsers ? '9 or more shop users' : `Up to ${plan.maxStaff} shop users`
            : text);
        }
        const insertOnly = { ...plan };
        for (const key of Object.keys(pricing)) delete insertOnly[key];
        await SubscriptionPlan.updateOne({ slug: plan.slug }, {
          $set: pricing,
          $setOnInsert: insertOnly,
        }, { session, upsert: true, runValidators: true, setDefaultsOnInsert: false });
      }
      const after = await SubscriptionPlan.find({ slug: { $in: slugs } }).session(session).lean();
      await PricingRevision.create([{ _id: LAUNCH_PRICING_REVISION, plansBefore: before, plansAfter: after }], { session });
    });
  } catch (error) {
    // A second server may finish the same revision while this one is writing.
    // Suppress only a confirmed winner; failures never serve the old prices.
    if (error.code !== 11000 || !await PricingRevision.exists({ _id: LAUNCH_PRICING_REVISION })) throw error;
  } finally {
    await session.endSession();
  }
}

/** Shared by public cards and authenticated billing before reading active plans. */
export async function ensureLaunchPricing() {
  if (ready) return;
  if (!inFlight) {
    inFlight = applyRevision().then(() => { ready = true; }).finally(() => { inFlight = null; });
  }
  await inFlight;
}
