// The one outbound call this service makes to dukana-admin-backend — the
// reverse of the existing internalApiClient.js there (which calls INTO this
// service). Reuses the same INTERNAL_API_SECRET already shared between both
// services for that direction; no new secret to provision.
//
// Best-effort only: a B2C result must never be lost if this call fails, so
// every error here is caught and logged, never thrown into the callback
// handler. dukana-admin-backend's daily reconciliation cron is the backstop
// for whatever this fails to deliver.

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * POST {DUKANA_ADMIN_INTERNAL_API_URL}/internal/commission-payouts/result
 *
 * Returns true only on a confirmed delivery — callers use this to decide
 * whether it's safe to mark the result as reconciled, or whether to leave it
 * for the backstop cron to pick up.
 */
export async function notifyCommissionPayoutResult({ reference, status, mpesaReceiptNumber, resultDesc }) {
  const baseUrl = process.env.DUKANA_ADMIN_INTERNAL_API_URL;
  const secret = process.env.INTERNAL_API_SECRET;
  if (!baseUrl || !secret) {
    console.error('[adminNotifyService] DUKANA_ADMIN_INTERNAL_API_URL / INTERNAL_API_SECRET not configured — result not pushed, relying on the backstop cron.');
    return false;
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/internal/commission-payouts/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference, status, mpesaReceiptNumber, resultDesc }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('[adminNotifyService] admin backend rejected the payout result:', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[adminNotifyService] Failed to push payout result to admin backend:', err.message);
    return false;
  }
}
