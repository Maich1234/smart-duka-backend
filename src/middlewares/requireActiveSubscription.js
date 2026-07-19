import Subscription from '../models/Subscription.js';
import PlatformConfig from '../models/PlatformConfig.js';
import { deriveAccess } from '../services/subscriptionPricingService.js';

const ACCESS_ALLOWED = ['trialing', 'active', 'grace'];

/**
 * Gates a route behind an active subscription (trialing/active/grace) —
 * plan-tier is irrelevant, since AI insights and every other paid feature
 * are available to any shop that's paying (or trialing), not just a
 * specific tier. First enforcement of this kind in the backend — every
 * other feature is gated client-side only (deriveAccess feeds UI banners,
 * nothing blocks the API). That's fine when a bypassed check just shows the
 * wrong screen; it isn't fine here, since each ungated call would burn real
 * Gemini API spend per shop.
 */
export const requireActiveSubscription = async (req, res, next) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;
    const [subscription, platform] = await Promise.all([
      Subscription.findOne({ shop: shopId }).populate('plan').lean(),
      PlatformConfig.get(),
    ]);

    const access = deriveAccess(subscription, platform.gracePeriodDays);
    if (!ACCESS_ALLOWED.includes(access.state)) {
      return res.status(403).json({ success: false, message: 'Your subscription needs to be active to use this feature.' });
    }

    // Expose the already-fetched, plan-populated doc so downstream
    // middlewares (enforceChatLimits, requireFeature) don't need a second query.
    req.subscription = subscription;
    next();
  } catch (err) {
    console.error('[requireActiveSubscription] error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to verify subscription access.' });
  }
};
