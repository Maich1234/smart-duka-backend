import crypto from 'crypto';
import PlatformConfig from '../../../models/PlatformConfig.js';
import { decrypt } from '../../../services/encryptionService.js';

const BASE_URL = 'https://api.paystack.co';

/**
 * Reads DuQana's own Paystack account — platform-level, like the Daraja
 * credentials in mpesaProvider, never a shop's own config. Admin-managed
 * (super-admin → Platform Config), same as M-Pesa, rather than env vars —
 * lets it be set/rotated/disabled without a deploy.
 */
export async function getConfig() {
  const platform = await PlatformConfig.get();
  const paystack = platform.paystack;
  const missing = [];
  if (!paystack?.enabled) missing.push('Paystack is not enabled');
  if (!paystack?.publicKey) missing.push('Public Key');
  if (!paystack?.secretKey) missing.push('Secret Key');
  if (missing.length > 0) {
    const err = new Error(`DuQana platform Paystack is not configured (${missing.join(', ')}). Configure it from the super-admin Platform Config page.`);
    err.code = 'PLATFORM_PAYMENTS_UNCONFIGURED';
    throw err;
  }

  let secretKey;
  try {
    secretKey = decrypt(paystack.secretKey);
  } catch (err) {
    throw new Error('Failed to decrypt the Paystack secret key. The ENCRYPTION_KEY may have changed. Please re-save it in Platform Config.');
  }
  return { secretKey, publicKey: paystack.publicKey };
}

/**
 * Confirms a transaction directly with Paystack — the reconciliation path
 * for a webhook that never arrived, or arrived but activation failed before
 * it could be recorded. Mirrors mpesaProvider.queryStatus's role.
 */
export async function verifyTransaction({ reference, secretKey }) {
  let response;
  try {
    response = await fetch(`${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Could not reach Paystack to verify the transaction: ${err.message}`);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new Error(body?.message || `Paystack verify returned HTTP ${response.status}`);
  }
  return body.data;
}

/**
 * Paystack signs webhook deliveries with an HMAC-SHA512 of the raw request
 * body, keyed on the secret key, sent as `x-paystack-signature`. This is the
 * only thing standing between "Safaricom-style trusted webhook" and anyone
 * on the internet POSTing a fake `charge.success` — never process a webhook
 * body without checking this first.
 */
export function verifyWebhookSignature({ rawBody, signature, secretKey }) {
  if (!rawBody || !signature) return false;
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(String(signature), 'utf8');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}
