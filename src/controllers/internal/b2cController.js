import PlatformConfig from '../../models/PlatformConfig.js';
import B2CTransaction from '../../models/B2CTransaction.js';
import { initiateB2CPayment, withMpesaCallbackSecret } from '../../services/mpesaService.js';

/** Validates that all fields B2C needs on the platform config are present. */
function missingB2CFields(mpesa) {
  const missing = [];
  if (!mpesa?.enabled) missing.push('M-Pesa is not enabled');
  if (!mpesa?.shortcode) missing.push('Shortcode');
  if (!mpesa?.consumerKey) missing.push('Consumer Key');
  if (!mpesa?.consumerSecret) missing.push('Consumer Secret');
  if (!mpesa?.initiatorName) missing.push('Initiator Name');
  if (!mpesa?.securityCredential) missing.push('Security Credential');
  return missing;
}

function getB2CResultUrl() {
  if (process.env.MPESA_B2C_RESULT_URL) return process.env.MPESA_B2C_RESULT_URL;
  // Derive from the STK callback URL: .../mpesa/callback → .../mpesa/b2c-result
  const stkUrl = process.env.MPESA_CALLBACK_URL;
  if (stkUrl?.endsWith('/callback')) return stkUrl.replace(/\/callback$/, '/b2c-result');
  return null;
}

/**
 * POST /internal/b2c/payout — service-to-service only (dukana-admin-backend).
 * Initiates a B2C payment from the platform's own Daraja account. The final
 * outcome arrives later via Safaricom's ResultURL/QueueTimeOutURL, which push
 * it onward to dukana-admin-backend (see adminNotifyService.js) — this
 * endpoint only returns the initiation acknowledgement.
 */
export const initiateB2CPayout = async (req, res) => {
  const { reference, phoneNumber, amount, remarks, occasion } = req.body;
  if (!reference || !phoneNumber || !amount) {
    return res.status(400).json({ success: false, message: 'reference, phoneNumber and amount are required' });
  }

  const platform = await PlatformConfig.get();
  const missing = missingB2CFields(platform.mpesa);
  if (missing.length > 0) {
    return res.status(503).json({ success: false, message: `M-Pesa B2C is not fully configured: ${missing.join(', ')}` });
  }

  // Defense in depth against a duplicate payout for the same reference — the
  // caller (dukana-admin-backend) already claims its CommissionRecord
  // atomically before calling here, but this guards against that claim ever
  // being bypassed or retried, so a second real Safaricom disbursement can
  // never fire for the same commission.
  const active = await B2CTransaction.findOne({ reference, status: { $in: ['pending', 'completed'] } });
  if (active) {
    return res.status(409).json({ success: false, message: 'A payout for this reference is already in progress or completed.' });
  }

  const resultUrlBase = getB2CResultUrl();
  const resultUrl = withMpesaCallbackSecret(resultUrlBase);
  const queueTimeoutUrl = resultUrlBase ? withMpesaCallbackSecret(`${resultUrlBase}-timeout`) : null;
  if (!resultUrl || !queueTimeoutUrl) {
    return res.status(503).json({ success: false, message: 'MPESA_B2C_RESULT_URL or MPESA_CALLBACK_SECRET is not configured on the server.' });
  }

  let payout;
  try {
    payout = await initiateB2CPayment({
      config: platform.mpesa,
      phoneNumber,
      amount,
      remarks,
      occasion,
      resultUrl,
      queueTimeoutUrl,
    });
  } catch (err) {
    return res.status(502).json({ success: false, message: `M-Pesa B2C request failed: ${err.message}` });
  }

  await B2CTransaction.create({
    conversationId: payout.conversationId,
    originatorConversationId: payout.originatorConversationId,
    reference,
    phoneNumber,
    amount,
    status: 'pending',
  });

  res.json({
    success: true,
    data: { conversationId: payout.conversationId, originatorConversationId: payout.originatorConversationId },
  });
};
