import { PUBLIC_WEB_URL } from '../../../utils/publicWebUrl.js';

// The web app already has a complete, tested checkout flow at this path —
// the mobile app has no purchase surface (Play Store policy), so this is the
// only place a renewal link may point. Shared by the reminder cron and the
// owner-triggered resend so both point at exactly the same URL.
export const SUBSCRIPTION_PAGE_URL = `${PUBLIC_WEB_URL}/owner/subscription`;

/**
 * The dedicated subscription callback takes priority over the sales fallback.
 * Both can already include the subscription segment.
 */
export function getSubscriptionCallbackUrl() {
  const dedicated = process.env.SUBSCRIPTION_MPESA_CALLBACK_URL?.trim();
  const base = dedicated || process.env.MPESA_CALLBACK_URL?.trim();
  if (!base) return null;

  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) return null;
    const callbackPath = /\/(?:subscriptions\/)*mpesa\/callback\/?$/;
    if (!callbackPath.test(url.pathname)) return dedicated ? url.toString() : null;

    url.pathname = url.pathname.replace(callbackPath, '/subscriptions/mpesa/callback');
    return url.toString();
  } catch {
    return null;
  }
}
