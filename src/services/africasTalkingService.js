// Africa's Talking SMS delivery for OTP codes.
// Uses the REST API directly (no SDK dependency required).

const AT_BASE_URL = 'https://api.africastalking.com/version1/messaging';

/**
 * Sends an SMS message via Africa's Talking.
 * Set AT_USERNAME and AT_API_KEY in environment variables.
 * For sandbox testing, set AT_USERNAME=sandbox and use the sandbox API key.
 */
export async function sendSMS(to, message) {
  const username = process.env.AT_USERNAME;
  const apiKey = process.env.AT_API_KEY;

  if (!username || !apiKey) {
    throw new Error('Africa\'s Talking credentials (AT_USERNAME, AT_API_KEY) are not configured');
  }

  const phone = formatPhone(to);

  const params = new URLSearchParams({
    username,
    to: phone,
    message,
  });

  const response = await fetch(AT_BASE_URL, {
    method: 'POST',
    headers: {
      apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = await response.json();
  const recipient = data?.SMSMessageData?.Recipients?.[0];

  if (!response.ok || recipient?.status !== 'Success') {
    const reason = recipient?.statusCode || data?.SMSMessageData?.Message || 'SMS delivery failed';
    throw new Error(`Africa's Talking SMS error: ${reason}`);
  }

  return { messageId: recipient.messageId, cost: recipient.cost };
}

/** Ensures phone is in international format for Africa's Talking (+254...). */
function formatPhone(phone) {
  let cleaned = String(phone).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
  if (!cleaned.startsWith('254')) cleaned = '254' + cleaned;
  return '+' + cleaned;
}
