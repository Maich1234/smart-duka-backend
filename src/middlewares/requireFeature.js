import Subscription from '../models/Subscription.js';

/** Pure check, exported for unit testing without a DB — see requireFeature below. */
export const hasFeature = (plan, featureKey) => (plan?.features ?? []).includes(featureKey);

/**
 * Gates a route behind a SubscriptionPlan.features flag. Reuses
 * req.subscription if an earlier middleware (requireActiveSubscription)
 * already populated it; otherwise fetches its own. A plan with no
 * `features` entry for this key is treated as not having the feature.
 */
export const requireFeature = (featureKey) => async (req, res, next) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;
    const subscription = req.subscription ?? await Subscription.findOne({ shop: shopId }).populate('plan').lean();
    if (!hasFeature(subscription?.plan, featureKey)) {
      return res.status(403).json({ success: false, message: "This feature isn't included in your current plan." });
    }
    next();
  } catch (err) {
    console.error('[requireFeature] error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to verify plan access.' });
  }
};
