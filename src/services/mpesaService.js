import { decrypt } from './encryptionService.js';

const SANDBOX_BASE = 'https://sandbox.safaricom.co.ke';
const PRODUCTION_BASE = 'https://api.safaricom.co.ke';

function getBaseUrl(environment) {
  return environment === 'production' ? PRODUCTION_BASE : SANDBOX_BASE;
}

/** Converts +254XXXXXXXXX → 254XXXXXXXXX (Safaricom API format, no + prefix). */
export function normalizeKenyanPhone(phone) {
  return String(phone).replace(/^\+/, '');
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

  let consumerKey, consumerSecret;
  try {
    consumerKey = decrypt(config.consumerKey);
    consumerSecret = decrypt(config.consumerSecret);
  } catch (err) {
    throw new Error('Failed to decrypt M-Pesa credentials. The ENCRYPTION_KEY may have changed. Please re-save your M-Pesa configuration in Profile → Payments.');
  }

  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  let response;
  try {
    response = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      method: 'GET',
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('ETIMEDOUT: M-Pesa OAuth request timed out after 15s');
    }
    throw new Error(`ECONNREFUSED: Could not connect to Safaricom API (${err.message})`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`M-Pesa OAuth failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`M-Pesa OAuth returned no access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

/**
 * Sends an STK Push (Lipa Na M-Pesa Online) request to the customer's phone.
 * Returns the Safaricom CheckoutRequestID used for status polling.
 */
export async function initiateSTKPush({ config, phoneNumber, amount, accountReference, transactionDesc, callbackUrl }) {
  const baseUrl = getBaseUrl(config.environment);
  const accessToken = await getAccessToken(config);

  let passkey;
  try {
    passkey = decrypt(config.passkey);
  } catch (err) {
    throw new Error('Failed to decrypt M-Pesa Passkey. Please re-save your M-Pesa configuration in Profile → Payments.');
  }
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
    AccountReference: accountReference || 'Dukana',
    TransactionDesc: transactionDesc || 'Sale Payment',
  };

  let response;
  try {
    response = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('ETIMEDOUT: STK Push request timed out after 20s');
    }
    throw new Error(`ECONNREFUSED: Could not connect to Safaricom API (${err.message})`);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ResponseCode !== '0') {
    const errMsg = data.errorMessage || data.ResponseDescription || data.ResultDesc || `HTTP ${response.status}`;
    throw new Error(`{"errorMessage":"${errMsg}","responseCode":"${data.ResponseCode ?? response.status}"}`);
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
 * Sends a Transaction Reversal request to Safaricom — refunds a received
 * C2B payment back to the customer. Asynchronous: Safaricom acks the request
 * here and posts the final outcome to resultUrl later.
 *
 * transactionId is the M-Pesa receipt number of the original payment (e.g.
 * "SGH3TZO2LP"). Requires initiator credentials (Daraja API operator).
 */
export async function initiateReversal({ config, transactionId, amount, remarks, resultUrl, queueTimeoutUrl }) {
  const baseUrl = getBaseUrl(config.environment);
  const accessToken = await getAccessToken(config);

  let securityCredential;
  try {
    securityCredential = decrypt(config.securityCredential);
  } catch (err) {
    throw new Error('Failed to decrypt the M-Pesa Security Credential. Please re-save your refund credentials in Profile → Payments.');
  }

  const body = {
    Initiator: config.initiatorName,
    SecurityCredential: securityCredential,
    CommandID: 'TransactionReversal',
    TransactionID: transactionId,
    Amount: Math.ceil(amount),
    ReceiverParty: config.shortcode,
    // '11' = organisation shortcode. Safaricom's API requires this misspelled
    // field name — do not "fix" it.
    RecieverIdentifierType: '11',
    ResultURL: resultUrl,
    QueueTimeOutURL: queueTimeoutUrl,
    Remarks: (remarks || 'Sale refund').slice(0, 100),
    Occasion: 'Refund',
  };

  let response;
  try {
    response = await fetch(`${baseUrl}/mpesa/reversal/v1/request`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('ETIMEDOUT: M-Pesa reversal request timed out after 20s');
    }
    throw new Error(`ECONNREFUSED: Could not connect to Safaricom API (${err.message})`);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ResponseCode !== '0') {
    const errMsg = data.errorMessage || data.ResponseDescription || data.ResultDesc || `HTTP ${response.status}`;
    throw new Error(`{"errorMessage":"${errMsg}","responseCode":"${data.ResponseCode ?? response.status}"}`);
  }

  return {
    originatorConversationId: data.OriginatorConversationID,
    conversationId: data.ConversationID,
    responseDescription: data.ResponseDescription,
  };
}

/**
 * Parses a Safaricom reversal Result callback into a normalised object.
 * ResultCode 0 = money returned to the customer; anything else is a failure.
 */
export function parseReversalResult(callbackBody) {
  const result = callbackBody?.Result;
  if (!result) throw new Error('Invalid reversal result structure');

  const params = result.ResultParameters?.ResultParameter ?? [];
  const getParam = (key) => {
    const list = Array.isArray(params) ? params : [params];
    return list.find((p) => p?.Key === key)?.Value;
  };

  return {
    success: String(result.ResultCode) === '0',
    resultCode: String(result.ResultCode),
    resultDesc: result.ResultDesc,
    originatorConversationId: result.OriginatorConversationID,
    conversationId: result.ConversationID,
    // Receipt of the reversal transaction itself
    transactionId: result.TransactionID || getParam('TransactionID'),
    amount: getParam('Amount') ?? getParam('TransactionAmount'),
  };
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
