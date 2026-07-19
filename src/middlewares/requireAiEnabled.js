/** Pure check, exported for unit testing without a request object. */
export const hasAiEnabled = (shop) => Boolean(shop?.aiEnabled);

/**
 * Gates a route behind Shop.aiEnabled — the owner's independent opt-in/out
 * for Gemini processing, separate from subscription tier. No DB call: protect
 * already populates req.user.shop (see middlewares/auth.js).
 */
export const requireAiEnabled = (req, res, next) => {
  if (!hasAiEnabled(req.user.shop)) {
    return res.status(403).json({ success: false, message: 'Enable Smart Duka AI from your Profile to use this feature.' });
  }
  next();
};
