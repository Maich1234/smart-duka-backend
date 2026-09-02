import { PUBLIC_WEB_URL } from '../../../utils/publicWebUrl.js';

// The web app already has a complete, tested checkout flow at this path —
// the mobile app has no purchase surface (Play Store policy), so this is the
// only place a renewal link may point. Shared by the reminder cron and the
// owner-triggered resend so both point at exactly the same URL.
export const SUBSCRIPTION_PAGE_URL = `${PUBLIC_WEB_URL}/owner/subscription`;

/**
 * The subscription STK callback needs its own public URL. Prefer the
 * dedicated env var; otherwise derive it from the sale-payment callback URL.
 */
export function getSubscriptionCallbackUrl() {
  if (process.env.SUBSCRIPTION_MPESA_CALLBACK_URL) return process.env.SUBSCRIPTION_MPESA_CALLBACK_URL;
  const saleCallback = process.env.MPESA_CALLBACK_URL;
  if (saleCallback?.includes('/mpesa/callback')) {
    return saleCallback.replace('/mpesa/callback', '/subscriptions/mpesa/callback');
  }
  return null;
}
