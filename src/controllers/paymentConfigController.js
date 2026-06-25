import PaymentConfig from '../models/PaymentConfig.js';
import { encrypt } from '../services/encryptionService.js';
import { logAudit } from '../services/auditLogService.js';

/** Returns M-Pesa config status (enabled/not) without sensitive data. Safe for all staff. */
export const getPaymentStatus = async (req, res) => {
  const shopId = req.user.shop._id ?? req.user.shop;
  const config = await PaymentConfig.findOne({ shop: shopId });

  res.json({
    success: true,
    data: {
      mpesa: {
        enabled: config?.mpesa?.enabled ?? false,
        environment: config?.mpesa?.environment ?? null,
        businessName: config?.mpesa?.businessName ?? null,
        shortcode: config?.mpesa?.shortcode ?? null,
        isConfigured: !!(config?.mpesa?.consumerKey),
      },
    },
  });
};

/**
 * Returns masked payment config. Requires identity verification.
 * Sensitive fields are replaced with a placeholder — never decrypted.
 */
export const getPaymentConfig = async (req, res) => {
  const shopId = req.user.shop._id ?? req.user.shop;
  const config = await PaymentConfig.findOne({ shop: shopId });

  const mpesa = config?.mpesa ?? {};
  const isConfigured = !!mpesa.consumerKey;

  res.json({
    success: true,
    data: {
      mpesa: {
        enabled: mpesa.enabled ?? false,
        environment: mpesa.environment ?? 'sandbox',
        businessName: mpesa.businessName ?? '',
        shortcode: mpesa.shortcode ?? '',
        // Never return actual credentials — only presence indicators
        consumerKeySet: isConfigured,
        consumerSecretSet: isConfigured,
        passkeySet: isConfigured,
        configuredAt: mpesa.configuredAt ?? null,
        configuredBy: mpesa.configuredBy ?? null,
      },
    },
  });
};

/** Saves (or replaces) M-Pesa credentials. Requires identity verification. Owner only. */
export const saveMpesaConfig = async (req, res) => {
  const shopId = req.user.shop._id ?? req.user.shop;
  const { environment, businessName, shortcode, consumerKey, consumerSecret, passkey } = req.body;

  const encryptedKey = encrypt(consumerKey);
  const encryptedSecret = encrypt(consumerSecret);
  const encryptedPasskey = encrypt(passkey);

  const config = await PaymentConfig.findOneAndUpdate(
    { shop: shopId },
    {
      $set: {
        'mpesa.enabled': true,
        'mpesa.environment': environment,
        'mpesa.businessName': businessName,
        'mpesa.shortcode': shortcode,
        'mpesa.consumerKey': encryptedKey,
        'mpesa.consumerSecret': encryptedSecret,
        'mpesa.passkey': encryptedPasskey,
        'mpesa.configuredAt': new Date(),
        'mpesa.configuredBy': req.user._id,
      },
    },
    { upsert: true, new: true }
  );

  await logAudit({
    shopId,
    userId: req.user._id,
    action: 'payment_config.mpesa.updated',
    entityType: 'PaymentConfig',
    entityId: config._id,
    details: { environment, businessName, shortcode },
    req,
  });

  res.json({ success: true, message: 'M-Pesa configuration saved successfully.' });
};

/** Disables and removes M-Pesa credentials. Requires identity verification. Owner only. */
export const disconnectMpesa = async (req, res) => {
  const shopId = req.user.shop._id ?? req.user.shop;

  const config = await PaymentConfig.findOneAndUpdate(
    { shop: shopId },
    {
      $set: {
        'mpesa.enabled': false,
        'mpesa.consumerKey': null,
        'mpesa.consumerSecret': null,
        'mpesa.passkey': null,
        'mpesa.shortcode': null,
        'mpesa.businessName': null,
        'mpesa.configuredAt': null,
        'mpesa.configuredBy': null,
      },
    },
    { new: true }
  );

  await logAudit({
    shopId,
    userId: req.user._id,
    action: 'payment_config.mpesa.disconnected',
    entityType: 'PaymentConfig',
    entityId: config?._id,
    req,
  });

  res.json({ success: true, message: 'M-Pesa account disconnected.' });
};
