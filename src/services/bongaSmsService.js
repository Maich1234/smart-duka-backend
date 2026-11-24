const MESSAGES_URL = 'https://api.bonga.pro/api/v1/messages';

export async function sendSMS(to, message) {
  const token = process.env.BONGA_API_TOKEN?.trim();
  const senderId = process.env.BONGA_SENDER_ID?.trim();
  if (!token || !senderId) {
    throw new Error('Bonga SMS requires BONGA_API_TOKEN and BONGA_SENDER_ID.');
  }

  const response = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ sender_id: senderId, phone: formatPhone(to), message }),
    signal: AbortSignal.timeout(10000),
  });

  const result = await response.json().catch(() => null);
  if (!response.ok || result?.success !== true || !result.data?.uuid) {
    // Provider responses may contain the recipient and OTP text.
    throw new Error(`Bonga SMS did not accept the message (HTTP ${response.status}).`);
  }
  return { messageId: result.data.uuid };
}

function formatPhone(phone) {
  const cleaned = String(phone).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('254')) return `+${cleaned}`;
  return `+254${cleaned.replace(/^0/, '')}`;
}
