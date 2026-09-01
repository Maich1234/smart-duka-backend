import crypto from 'crypto';
import { getConfig, verifyTransaction } from '../paystackService.js';

/**
 * Card / bank transfer payments via Paystack, restricted to non-card
 * channels — "adding bank payments", not opting the still-stubbed
 * cardProvider into Paystack too.
 *
 * Unlike M-Pesa's STK push (server calls Safaricom directly, amount is
 * locked in before the customer ever sees a prompt), Paystack's popup runs
 * client-side against the public key: the browser calls Paystack, not us.
 * That means `amount` reaches Paystack via a value the browser controls, so
 * — unlike mpesaProvider — nothing here can guarantee up front what actually
 * gets charged. The integrity check has to happen after the fact, comparing
 * what Paystack confirms was charged against what we expected
 * (reconcilePayment and the webhook handler both do this before ever
 * crediting a subscription).
 */
export default {
  key: 'bank',
  label: 'Card / Bank transfer',
  available: true,

  getConfig,

  /**
   * No network call: there's nothing to charge yet. The reference is
   * reserved here so the client and the eventual Paystack webhook/verify
   * response all agree on the same id; the public key lets the browser open
   * the popup directly against Paystack.
   */
  async charge({ reference }) {
    const config = await this.getConfig();
    const providerRef = reference && reference !== 'DUKANA'
      ? reference
      : `DKN-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    return {
      providerRef,
      publicKey: config.publicKey,
    };
  },

  /** Normalizes a Paystack `charge.success` webhook body. */
  parseCallback(body) {
    const data = body?.data ?? {};
    return {
      providerRef: data.reference,
      success: body?.event === 'charge.success' && data.status === 'success',
      resultCode: data.status ?? null,
      resultDesc: data.gateway_response ?? null,
      receipt: data.reference ?? null,
      // Extra, Paystack-specific fields — ignored by callers that don't ask
      // for them (M-Pesa's webhook path never sets these).
      amountKobo: data.amount ?? null,
      currency: data.currency ?? null,
    };
  },

  /** Confirms a transaction directly with Paystack — the recheck/cron path. */
  async queryStatus({ checkoutRequestId: reference }) {
    const config = await this.getConfig();
    const data = await verifyTransaction({ reference, secretKey: config.secretKey });
    const success = data?.status === 'success';
    return {
      resultCode: data?.status ?? null,
      resultDesc: data?.gateway_response ?? null,
      success,
      amountKobo: data?.amount ?? null,
      currency: data?.currency ?? null,
    };
  },
};
