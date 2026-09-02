const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verifies a Cloudflare Turnstile token before an unauthenticated, costly
 * endpoint (one that sends an email or writes to the DB) does its work.
 * Runs before Joi validation so it can read `turnstileToken` before
 * `stripUnknown` would otherwise remove it.
 */
export const verifyTurnstile = async (req, res, next) => {
  const token = req.body?.turnstileToken;
  if (!token) {
    return res.status(400).json({ success: false, message: 'Please complete the verification challenge and try again.' });
  }

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Neither silently accept (defeats the point) nor silently 500 forever —
    // a missing env var should be loud in the logs and clearly explained to
    // the submitter, not read as "the form is just broken".
    console.error('[verifyTurnstile] TURNSTILE_SECRET_KEY is not set — rejecting.');
    return res.status(503).json({ success: false, message: 'This form is temporarily unavailable. Please email us directly.' });
  }

  try {
    const params = new URLSearchParams({ secret, response: token });
    if (req.ip) params.set('remoteip', req.ip);

    const verifyRes = await fetch(VERIFY_URL, {
      method: 'POST',
      body: params,
      signal: AbortSignal.timeout(5000),
    });
    const data = await verifyRes.json();

    if (!data.success) {
      return res.status(400).json({ success: false, message: 'Verification failed — please try again.' });
    }
    next();
  } catch (err) {
    console.error('[verifyTurnstile] verification request failed:', err.message);
    return res.status(503).json({ success: false, message: 'Could not verify your submission right now. Please try again shortly.' });
  }
};
