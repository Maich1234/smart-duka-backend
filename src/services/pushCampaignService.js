import Shop from '../models/Shop.js';
import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import PlatformConfig from '../models/PlatformConfig.js';
import PushCampaign from '../models/PushCampaign.js';
import { deriveAccess } from './subscriptionPricingService.js';
import { sendPushToUsers } from '../utils/push.js';

/** Shop ids currently subscribed to one of the given plan slugs. */
async function shopIdsForPlans(planSlugs) {
  const plans = await SubscriptionPlan.find({ slug: { $in: planSlugs } }).select('_id').lean();
  const subscriptions = await Subscription.find({ plan: { $in: plans.map((p) => p._id) } }).select('shop').lean();
  return subscriptions.map((s) => s.shop);
}

/** Shop ids whose derived access state is one of the given states. */
async function shopIdsForStates(states) {
  const platform = await PlatformConfig.get();
  const [shops, subscriptions] = await Promise.all([
    Shop.find({ isActive: true }).select('_id').lean(),
    Subscription.find({}).lean(),
  ]);
  const subByShop = new Map(subscriptions.map((s) => [String(s.shop), s]));
  return shops
    .filter((shop) => {
      const subscription = subByShop.get(String(shop._id)) ?? null;
      const access = deriveAccess(subscription, platform.gracePeriodDays);
      return states.includes(access.state);
    })
    .map((shop) => shop._id);
}

/** Shop ids in a given country whose county matches one of the given names. */
async function shopIdsForLocation({ country, counties }) {
  const shops = await Shop.find({ country, county: { $in: counties } }).select('_id').lean();
  return shops.map((s) => s._id);
}

/** Resolves a campaign's segment definition into the Users to push to. `shop` is
 *  populated with the fields {{shopName}}/{{location}} interpolation needs. */
export async function resolveSegmentTargets(segment) {
  const roles = segment.roles?.length ? segment.roles : ['owner'];
  const shopFields = 'name county subCounty country';

  if (segment.type === 'all') {
    return User.find({ role: { $in: roles }, isActive: true }).populate('shop', shopFields);
  }

  let shopIds;
  if (segment.type === 'plan') shopIds = await shopIdsForPlans(segment.planSlugs);
  else if (segment.type === 'location') shopIds = await shopIdsForLocation(segment);
  else shopIds = await shopIdsForStates(segment.states);

  return User.find({ shop: { $in: shopIds }, role: { $in: roles }, isActive: true }).populate('shop', shopFields);
}

/** Sends an already-claimed campaign and records the outcome. */
export async function dispatchCampaign(campaign) {
  try {
    const users = await resolveSegmentTargets(campaign.segment);
    const data = campaign.data && campaign.data.size ? Object.fromEntries(campaign.data) : undefined;
    const result = await sendPushToUsers(users, { title: campaign.title, body: campaign.body, data });
    campaign.status = 'sent';
    campaign.sentAt = new Date();
    campaign.stats = result;
  } catch (err) {
    console.error('[PushCampaign] dispatch failed:', err.message);
    campaign.status = 'failed';
  }
  await campaign.save();
  return campaign;
}

/**
 * Atomically claims a scheduled campaign — so a "Send now" click racing the
 * dispatcher cron can never send the same campaign twice — then dispatches
 * it. Returns null if it wasn't claimable (already sending/sent/cancelled,
 * or not found), the single dispatch path both the admin endpoint and the
 * cron use.
 */
export async function claimAndDispatchCampaign(campaignId) {
  const claimed = await PushCampaign.findOneAndUpdate(
    { _id: campaignId, status: 'scheduled' },
    { $set: { status: 'sending' } },
    { new: true }
  );
  if (!claimed) return null;
  return dispatchCampaign(claimed);
}
