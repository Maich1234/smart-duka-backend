import PlatformConfig from '../../models/PlatformConfig.js';
import { initiateSTKPush, parseSTKCallback, normalizeKenyanPhone } from '../mpesaService.js';

/**
 * Collects subscription payments into SmartDuka's own Daraja account
 * (PlatformConfig singleton) — never a shop's PaymentConfig. Reuses the
 * shop-payment mpesaService wholesale: only the credential source differs.
 */
export default {
  key: 'mpesa',
  label: 'M-PESA',
  available: true,

  /** Loads and validates the platform Daraja credentials. */
  async getConfig() {
    const platform = await PlatformConfig.get();
    const mpesa = platform.mpesa;
    const missing = [];
    if (!mpesa?.enabled) missing.push('M-Pesa is not enabled');
    if (!mpesa?.shortcode) missing.push('Shortcode');
    if (!mpesa?.consumerKey) missing.push('Consumer Key');
    if (!mpesa?.consumerSecret) missing.push('Consumer Secret');
    if (!mpesa?.passkey) missing.push('Passkey');
    if (missing.length > 0) {
      const err = new Error(`SmartDuka platform M-Pesa is not configured (${missing.join(', ')}). Seed it with scripts/seedPlatformConfig.mjs or configure it from the super-admin page.`);
      err.code = 'PLATFORM_PAYMENTS_UNCONFIGURED';
      throw err;
    }
    return mpesa;
  },

  /**
   * Sends an STK Push to the shop owner's phone.
   * Returns { providerRef, merchantRequestId, phoneNumber }.
   */
  async charge({ phoneNumber, amount, reference, description, callbackUrl }) {
    const config = await this.getConfig();
    const result = await initiateSTKPush({
      config,
      phoneNumber,
      amount,
      accountReference: reference || 'SMARTDUKA',
      transactionDesc: description || 'Smart Duka subscription',
      callbackUrl,
    });
    return {
      providerRef: result.checkoutRequestId,
      merchantRequestId: result.merchantRequestId,
      phoneNumber: normalizeKenyanPhone(phoneNumber),
    };
  },

  /** Normalizes the Safaricom webhook body. */
  parseCallback(body) {
    const parsed = parseSTKCallback(body);
    return {
      providerRef: parsed.checkoutRequestId,
      success: parsed.success,
      resultCode: parsed.resultCode,
      resultDesc: parsed.resultDesc,
      receipt: parsed.mpesaReceiptNumber ?? null,
    };
  },
};
