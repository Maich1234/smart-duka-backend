import { signWebviewToken } from '../../utils/webviewToken.js';

/**
 * POST /auth/webview-token — mints a short-lived token for the mobile app's
 * embedded Setup Guide WebView. Owner-only: the Setup Guide is an owner
 * concern (product/payment/staff setup), same scope as GettingStartedChecklist.
 */
export const mintWebviewToken = async (req, res) => {
  const shopId = req.user.shop._id ?? req.user.shop;
  const token = signWebviewToken(shopId);
  res.json({ success: true, data: { token, expiresIn: 600 } });
};
