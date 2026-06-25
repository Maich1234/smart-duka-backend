import { decrypt } from './encryptionService.js';

const SANDBOX_BASE = 'https://sandbox.safaricom.co.ke';
const PRODUCTION_BASE = 'https://api.safaricom.co.ke';

function getBaseUrl(environment) {
  return environment === 'production' ? PRODUCTION_BASE : SANDBOX_BASE;
}

/** Normalises any Kenyan phone format to 254XXXXXXXXX (no + prefix). */
export function normalizeKenyanPhone(phone) {
  let cleaned = String(phone).replace(/[^\d]/g, '');
  if (cleaned.startsWith('0')) cleaned = '254' + cleaned.slice(1);
  if (cleaned.startsWith('7') || cleaned.startsWith('1')) cleaned = '254' + cleaned;
  return cleaned;
}

function getTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[-T:.Z]/g, '')
    .slice(0, 14);
}

function buildPassword(shortcode, passkey, timestamp) {
  const raw = `${shortcode}${passkey}${timestamp}`;
  return Buffer.from(raw).toString('base64');
}

/**
 * Fetches a short-lived OAuth2 access token from Safaricom.
 * Consumer key and secret are decrypted only for this request.
 */
async function getAccessToken(config) {
  const baseUrl = getBaseUrl(config.environment);
  const consumerKey = decrypt(config.consumerKey);
  const consumerSecret = decrypt(config.consumerSecret);

  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const response = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'GET',
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`M-Pesa OAuth failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Sends an STK Push (Lipa Na M-Pesa Online) request to the customer's phone.
 * Returns the Safaricom CheckoutRequestID used for status polling.
 */
export async function initiateSTKPush({ config, phoneNumber, amount, accountReference, transactionDesc, callbackUrl }) {
  const baseUrl = getBaseUrl(config.environment);
  const accessToken = await getAccessToken(config);
  const passkey = decrypt(config.passkey);
  const timestamp = getTimestamp();
  const password = buildPassword(config.shortcode, passkey, timestamp);
  const phone = normalizeKenyanPhone(phoneNumber);

  const body = {
    BusinessShortCode: config.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.ceil(amount),
    PartyA: phone,
    PartyB: config.shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: accountReference || 'SmartDuka',
    TransactionDesc: transactionDesc || 'Sale Payment',
  };

  const response = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok || data.ResponseCode !== '0') {
    throw new Error(data.errorMessage || data.ResponseDescription || 'STK Push initiation failed');
  }

  return {
    merchantRequestId: data.MerchantRequestID,
    checkoutRequestId: data.CheckoutRequestID,
    responseDescription: data.ResponseDescription,
  };
}

/**
 * Queries Safaricom for the current status of a pending STK Push.
 * Used as a fallback when the callback hasn't arrived yet.
 */
export async function querySTKStatus({ config, checkoutRequestId }) {
  const baseUrl = getBaseUrl(config.environment);
  const accessToken = await getAccessToken(config);
  const passkey = decrypt(config.passkey);
  const timestamp = getTimestamp();
  const password = buildPassword(config.shortcode, passkey, timestamp);

  const body = {
    BusinessShortCode: config.shortcode,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId,
  };

  const response = await fetch(`${baseUrl}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  return data;
}

/**
 * Parses a Safaricom STK callback body into a normalised result object.
 */
export function parseSTKCallback(callbackBody) {
  const callback = callbackBody?.Body?.stkCallback;
  if (!callback) throw new Error('Invalid callback structure');

  const resultCode = String(callback.ResultCode);
  const resultDesc = callback.ResultDesc;
  const merchantRequestId = callback.MerchantRequestID;
  const checkoutRequestId = callback.CheckoutRequestID;

  // ResultCode 0 = success
  if (resultCode !== '0') {
    return { success: false, resultCode, resultDesc, merchantRequestId, checkoutRequestId };
  }

  const items = callback.CallbackMetadata?.Item ?? [];
  const getItem = (name) => items.find((i) => i.Name === name)?.Value;

  return {
    success: true,
    resultCode,
    resultDesc,
    merchantRequestId,
    checkoutRequestId,
    amount: getItem('Amount'),
    mpesaReceiptNumber: getItem('MpesaReceiptNumber'),
    transactionDate: getItem('TransactionDate'),
    phoneNumber: String(getItem('PhoneNumber') ?? ''),
  };
}
