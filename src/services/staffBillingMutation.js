import mongoose from 'mongoose';
import Shop from '../models/Shop.js';
import Subscription from '../models/Subscription.js';
import { getBillableUserCount } from './subscriptionPricingService.js';
import { computeSeatChange } from './seatBillingService.js';

/** Staff changes and their invoice adjustment are one committed operation.
 * The shop write serializes head-count changes even before a subscription
 * exists. Transaction retries re-read the count; callbacks must have no
 * email, push or other external side effects. */
export async function mutateStaffWithBilling({ shopId, reason, mutate }) {
  const session = await mongoose.startSession();
  let committed;
  try {
    await session.withTransaction(async () => {
      const lock = await Shop.updateOne({ _id: shopId }, { $inc: { staffBillingRevision: 1 } }, { session });
      if (!lock.matchedCount) throw Object.assign(new Error('This shop is no longer available.'), { status: 404 });
      const beforeCount = await getBillableUserCount(shopId, session);
      const subscription = await Subscription.findOne({ shop: shopId }).session(session).populate({ path: 'plan', options: { session } });
      const result = await mutate(session);
      const afterCount = await getBillableUserCount(shopId, session);
      let adjustment = null;
      if (subscription) {
        if (subscription.plan && beforeCount !== afterCount) {
          const change = computeSeatChange({ plan: subscription.plan, subscription, fromCount: beforeCount, toCount: afterCount });
          if (change.proratedAmount !== 0) {
            adjustment = { ...change, reason: result.billingReason ?? reason, staff: result.staff?._id ?? null, staffName: result.staff?.name ?? '', createdAt: new Date() };
            subscription.seatAdjustments.push(adjustment);
          }
        }
        subscription.staffCount = afterCount;
        await subscription.save({ session });
      }
      committed = { ...result, subscription, adjustment };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    // Later verification email helpers may save the user after commit.
    committed.staff?.$session(null);
    committed.subscription?.$session(null);
    return committed;
  } finally { await session.endSession(); }
}
