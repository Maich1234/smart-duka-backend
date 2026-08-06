import { verifyWebviewToken } from '../utils/webviewToken.js';
import { getSetupStatus } from '../services/setupStatusService.js';

/**
 * GET /setup/status?token=... — the only endpoint that accepts a webview
 * token. Unauthenticated at the Express layer (no `protect`) because the
 * caller is a stripped web page with no login of its own; the handler itself
 * verifies the token's signature, expiry, and purpose before trusting the
 * shop it names.
 */
export const getEmbeddedSetupStatus = async (req, res) => {
  const shopId = verifyWebviewToken(req.query.token);
  if (!shopId) {
    return res.status(401).json({ success: false, message: 'Invalid or expired link. Reopen the Setup Guide from the app.' });
  }

  const status = await getSetupStatus(shopId);
  res.json({ success: true, data: status });
};
