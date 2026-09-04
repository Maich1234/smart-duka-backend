import Subscription from '../models/Subscription.js';
import PlatformConfig from '../models/PlatformConfig.js';
import { deriveAccess } from '../services/subscriptionPricingService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Gates the *transactional* API — recording sales, voiding/refunding them,
 * starting shifts, moving stock, purchases, expenses — behind a live
 * subscription.
 *
 * Distinct from requireActiveSubscription (which guards the paid extras:
 * AI, reports, analytics) in two ways that matter:
 *
 *  1. It closes a revenue leak. Owner lock-out was enforced only in the
 *     clients — the owner tab layout redirected to a paywall and the web
 *     dashboard did the same — while staff were never gated anywhere, and no
 *     transactional route was gated server-side at all. A locked shop simply
 *     kept trading through staff accounts, indefinitely, for free.
 *
 *  2. It stops the till last, not first. Staff keep selling for
 *     `staffGraceExtraDays` beyond the owner's grace window, because a shop
 *     that cannot take money churns while a shop that cannot see its reports
 *     renews. The owner meets the paywall immediately; the counter keeps
 *     working while they find the money.
 *
 * Read-only routes are deliberately not gated: a locked shop must always be
 * able to see its own history, and blocking that would be hostile without
 * being persuasive.
 */
export const requirePaidShop = async (req, res, next) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;
    const [subscription, platform] = await Promise.all([
      Subscription.findOne({ shop: shopId }).populate('plan').lean(),
      PlatformConfig.get(),
    ]);

    const access = deriveAccess(subscription, platform.gracePeriodDays);
    req.subscription = subscription;
    req.access = access;

    if (access.state !== 'locked') return next();

    // Locked for the owner — staff may still have runway.
    if (req.user.role === 'staff' && access.expiresAt) {
      const staffGraceEnd = new Date(
        new Date(access.expiresAt).getTime()
        + (platform.gracePeriodDays + (subscription?.graceExtensionDays ?? 0) + platform.staffGraceExtraDays) * DAY_MS,
      );
      if (new Date() <= staffGraceEnd) {
        req.staffGraceDaysLeft = Math.ceil((staffGraceEnd - new Date()) / DAY_MS);
        res.set('X-Subscription-Grace-Days-Left', String(req.staffGraceDaysLeft));
        return next();
      }
    }

    return res.status(403).json({
      success: false,
      code: 'SUBSCRIPTION_LOCKED',
      message: req.user.role === 'owner'
        ? 'Your subscription has ended. Renew to start recording sales again.'
        : 'This shop\'s subscription has ended. Ask the shop owner to renew.',
    });
  } catch (err) {
    // Never let a subscription-check failure stop a shop from selling. A
    // false lock at the counter is far more damaging than a few unbilled
    // transactions during an outage.
    console.error('[requirePaidShop] error:', err.message);
    return next();
  }
};
