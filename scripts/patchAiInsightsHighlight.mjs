/**
 * AI insights moved from a Business-only perk to something every active
 * subscription gets (see requireActiveSubscription — no more plan-feature
 * check). This patches already-seeded SubscriptionPlan documents so
 * Starter's marketing copy reflects that too. Additive only, safe to
 * re-run.
 *
 * Usage: node scripts/patchAiInsightsHighlight.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import SubscriptionPlan from '../src/models/SubscriptionPlan.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const plans = await SubscriptionPlan.find({});
  for (const plan of plans) {
    let changed = false;
    if (!plan.features.includes('ai_insights')) {
      plan.features.push('ai_insights');
      changed = true;
    }
    if (!plan.highlights.some((h) => /ai[- ]powered/i.test(h))) {
      plan.highlights.push('AI-powered business insights');
      changed = true;
    }
    if (changed) {
      await plan.save();
      console.log(`Updated "${plan.name}" (${plan.slug})`);
    } else {
      console.log(`"${plan.name}" (${plan.slug}) already up to date`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
