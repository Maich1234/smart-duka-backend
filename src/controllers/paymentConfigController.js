import PaymentConfig from '../models/PaymentConfig.js';
import { encrypt, decrypt } from '../services/encryptionService.js';
import { logAudit } from '../services/auditLogService.js';
import { notifySecurityEvent } from '../utils/securityAlerts.js';

function maskCredential(encryptedValue) {
  if (!encryptedValue) return null;
  try {
    const plain = decrypt(encryptedValue);
    if (!plain) return null;
    if (plain.length <= 6) return '•'.repeat(plain.length);
    // Reveal at most 7 characters total (3 head + 4 tail) — fine for a real
    // Daraja credential (32-64 chars) — but never more than ~30% of a short
    // one. Without this floor, a credential at the 10-char Joi minimum would
    // show 7 of 10 characters (70%) through this "masked" preview.
    const revealCap = Math.min(7, Math.max(2, Math.floor(plain.length * 0.3)));
    const head = Math.min(3, Math.ceil(revealCap / 2));
    const tail = Math.min(4, revealCap - head);
    const maskedLen = Math.max(4, plain.length - head - tail);
    return `${plain.slice(0, head)}${'•'.repeat(maskedLen)}${tail ? plain.slice(-tail) : ''}`;
  } catch {
    return '••••••••••••••••';
  }
}

/** Returns M-Pesa config status (enabled/not) without sensitive data. Safe for all staff. */
export const getPaymentStatus = async (req, res) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;
    const config = await PaymentConfig.findOne({ shop: shopId });
    return res.json({
      success: true,
      data: {
        mpesa: {
          enabled: config?.mpesa?.enabled ?? false,
          environment: config?.mpesa?.environment ?? null,
          businessName: config?.mpesa?.businessName ?? null,
          shortcode: config?.mpesa?.shortcode ?? null,
          isConfigured: !!(config?.mpesa?.consumerKey),
          // M-Pesa refunds (reversals) need the separate initiator credentials
          refundsConfigured: !!(config?.mpesa?.initiatorName && config?.mpesa?.securityCredential),
        },
      },
    });
  } catch (err) {
    console.error('[PaymentConfig] getPaymentStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch payment status.' });
  }
};

/**
 * Returns masked payment config. Requires identity verification.
 * Sensitive fields are replaced with a placeholder — never decrypted.
 */
export const getPaymentConfig = async (req, res) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;
    const config = await PaymentConfig.findOne({ shop: shopId });

    const mpesa = config?.mpesa ?? {};
    const isConfigured = !!mpesa.consumerKey;

    return res.json({
      success: true,
      data: {
        mpesa: {
          enabled: mpesa.enabled ?? false,
          environment: mpesa.environment ?? 'sandbox',
          businessName: mpesa.businessName ?? '',
          shortcode: mpesa.shortcode ?? '',
          consumerKeySet: !!mpesa.consumerKey,
          consumerSecretSet: !!mpesa.consumerSecret,
          passkeySet: !!mpesa.passkey,
          initiatorName: mpesa.initiatorName ?? '',
          securityCredentialSet: !!mpesa.securityCredential,
          // Masked credential previews (first 3 + •••• + last 4) — never full plaintext
          consumerKeyMasked: maskCredential(mpesa.consumerKey),
          consumerSecretMasked: maskCredential(mpesa.consumerSecret),
          passkeyMasked: maskCredential(mpesa.passkey),
          securityCredentialMasked: maskCredential(mpesa.securityCredential),
          configuredAt: mpesa.configuredAt ?? null,
          configuredBy: mpesa.configuredBy ?? null,
        },
      },
    });
  } catch (err) {
    console.error('[PaymentConfig] getPaymentConfig error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch payment configuration.' });
  }
};

/** Saves (or replaces) M-Pesa credentials. Requires identity verification. Owner only. */
export const saveMpesaConfig = async (req, res) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;
    const { environment, businessName, shortcode, consumerKey, consumerSecret, passkey, initiatorName, securityCredential } = req.body;

    const updates = {
      'mpesa.enabled': true,
      'mpesa.environment': environment,
      'mpesa.businessName': businessName,
      'mpesa.shortcode': shortcode,
      'mpesa.configuredAt': new Date(),
      'mpesa.configuredBy': req.user._id,
    };
    // Refund credentials are optional — undefined leaves the stored value
    // untouched, an explicit empty string clears it (turns refunds off).
    if (initiatorName !== undefined) updates['mpesa.initiatorName'] = initiatorName || null;

    try {
      if (consumerKey) updates['mpesa.consumerKey'] = encrypt(consumerKey);
      if (consumerSecret) updates['mpesa.consumerSecret'] = encrypt(consumerSecret);
      if (passkey) updates['mpesa.passkey'] = encrypt(passkey);
      if (securityCredential) updates['mpesa.securityCredential'] = encrypt(securityCredential);
      else if (securityCredential === '') updates['mpesa.securityCredential'] = null;
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to encrypt credentials. Contact the app administrator.' });
    }

    const config = await PaymentConfig.findOneAndUpdate(
      { shop: shopId },
      { $set: updates },
      { upsert: true, new: true }
    );

    logAudit({
      shopId,
      userId: req.user._id,
      action: 'payment_config.mpesa.updated',
      entityType: 'PaymentConfig',
      entityId: config._id,
      details: { environment, businessName, shortcode },
      req,
    }).catch(() => {});
    await notifySecurityEvent(req.user, 'mpesa_config_updated', { req });

    return res.json({ success: true, message: 'M-Pesa configuration saved successfully.' });
  } catch (err) {
    console.error('[PaymentConfig] saveMpesaConfig error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save M-Pesa configuration. Please try again.' });
  }
};

/** Disables and removes M-Pesa credentials. Requires identity verification. Owner only. */
export const disconnectMpesa = async (req, res) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;

    const config = await PaymentConfig.findOneAndUpdate(
      { shop: shopId },
      {
        $set: {
          'mpesa.enabled': false,
          'mpesa.consumerKey': null,
          'mpesa.consumerSecret': null,
          'mpesa.passkey': null,
          'mpesa.initiatorName': null,
          'mpesa.securityCredential': null,
          'mpesa.shortcode': null,
          'mpesa.businessName': null,
          'mpesa.configuredAt': null,
          'mpesa.configuredBy': null,
        },
      },
      { new: true }
    );

    logAudit({
      shopId,
      userId: req.user._id,
      action: 'payment_config.mpesa.disconnected',
      entityType: 'PaymentConfig',
      entityId: config?._id,
      req,
    }).catch(() => {});
    await notifySecurityEvent(req.user, 'mpesa_disconnected', { req });

    return res.json({ success: true, message: 'M-Pesa account disconnected.' });
  } catch (err) {
    console.error('[PaymentConfig] disconnectMpesa error:', err);
    return res.status(500).json({ success: false, message: 'Failed to disconnect M-Pesa. Please try again.' });
  }
};
