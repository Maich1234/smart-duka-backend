import PlatformConfig from '../models/PlatformConfig.js';
import { encrypt, isEncrypted } from '../services/encryptionService.js';
import { logAudit } from '../services/auditLogService.js';

/**
 * GET /admin/platform-config — secret fields are NEVER sent to the frontend,
 * even encrypted. Only a "configured" boolean per secret, derived from
 * isEncrypted() on the stored value.
 */
export const getPlatformConfig = async (req, res) => {
  const platform = await PlatformConfig.get();
  const mpesa = platform.mpesa ?? {};
  const paystack = platform.paystack ?? {};

  // Only log a direct GET — updatePlatformConfig re-renders via this same
  // function, and that already gets its own '.updated' entry.
  if (req.method === 'GET') {
    logAudit({
      action: 'admin.platform_config.viewed',
      details: { adminId: String(req.admin._id), adminEmail: req.admin.email },
      req,
    }).catch(() => {});
  }

  res.json({
    success: true,
    data: {
      mpesa: {
        enabled: mpesa.enabled ?? false,
        environment: mpesa.environment ?? 'sandbox',
        businessName: mpesa.businessName ?? '',
        shortcode: mpesa.shortcode ?? '',
        consumerKeyConfigured: isEncrypted(mpesa.consumerKey),
        consumerSecretConfigured: isEncrypted(mpesa.consumerSecret),
        passkeyConfigured: isEncrypted(mpesa.passkey),
        configuredAt: mpesa.configuredAt ?? null,
      },
      paystack: {
        enabled: paystack.enabled ?? false,
        // Not a secret — the web client needs the actual value to open the
        // payment popup, unlike M-Pesa's credentials which never leave the
        // server.
        publicKey: paystack.publicKey ?? '',
        secretKeyConfigured: isEncrypted(paystack.secretKey),
        configuredAt: paystack.configuredAt ?? null,
      },
      immediateSeatBilling: platform.immediateSeatBilling ?? false,
      gracePeriodDays: platform.gracePeriodDays,
      staffGraceExtraDays: platform.staffGraceExtraDays,
      reminderDaysBefore: platform.reminderDaysBefore,
    },
  });
};

/**
 * PATCH /admin/platform-config — credential fields are only re-encrypted and
 * overwritten when a non-empty value is actually sent; an absent or empty
 * field always means "leave the existing credential unchanged" (never
 * silently wipes a working credential from a partial form submit).
 */
export const updatePlatformConfig = async (req, res) => {
  const platform = await PlatformConfig.get();
  const {
    enabled, environment, businessName, shortcode, consumerKey, consumerSecret, passkey,
    paystackEnabled, paystackPublicKey, paystackSecretKey,
    immediateSeatBilling, gracePeriodDays, staffGraceExtraDays, reminderDaysBefore,
  } = req.body;

  const mpesa = platform.mpesa?.toObject ? platform.mpesa.toObject() : { ...(platform.mpesa ?? {}) };
  if (enabled !== undefined) mpesa.enabled = enabled;
  if (environment !== undefined) mpesa.environment = environment;
  if (businessName !== undefined) mpesa.businessName = businessName;
  if (shortcode !== undefined) mpesa.shortcode = shortcode;
  if (consumerKey) mpesa.consumerKey = encrypt(consumerKey);
  if (consumerSecret) mpesa.consumerSecret = encrypt(consumerSecret);
  if (passkey) mpesa.passkey = encrypt(passkey);
  if (consumerKey || consumerSecret || passkey || enabled !== undefined) mpesa.configuredAt = new Date();
  platform.mpesa = mpesa;

  const paystack = platform.paystack?.toObject ? platform.paystack.toObject() : { ...(platform.paystack ?? {}) };
  if (paystackEnabled !== undefined) paystack.enabled = paystackEnabled;
  if (paystackPublicKey !== undefined) paystack.publicKey = paystackPublicKey;
  if (paystackSecretKey) paystack.secretKey = encrypt(paystackSecretKey);
  if (paystackSecretKey || paystackPublicKey !== undefined || paystackEnabled !== undefined) paystack.configuredAt = new Date();
  platform.paystack = paystack;

  if (immediateSeatBilling !== undefined) platform.immediateSeatBilling = immediateSeatBilling;
  if (gracePeriodDays !== undefined) platform.gracePeriodDays = gracePeriodDays;
  if (staffGraceExtraDays !== undefined) platform.staffGraceExtraDays = staffGraceExtraDays;
  if (reminderDaysBefore !== undefined) platform.reminderDaysBefore = reminderDaysBefore;

  await platform.save();

  logAudit({
    action: 'admin.platform_config.updated',
    entityType: 'PlatformConfig',
    entityId: platform._id,
    // Field names only — never the values, which may be raw credentials.
    details: { adminId: String(req.admin._id), adminEmail: req.admin.email, fieldsChanged: Object.keys(req.body) },
    req,
  }).catch(() => {});

  return getPlatformConfig(req, res);
};
