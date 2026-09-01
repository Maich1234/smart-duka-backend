// Safaricom's Daraja API has no webhook-signing mechanism, so every M-Pesa
// callback URL we hand it embeds a shared secret as its final path segment
// (see withMpesaCallbackSecret in services/mpesaService.js) instead. This
// checks that segment — the only thing standing between these endpoints
// (which must stay publicly reachable, no JWT) and anyone on the internet
// forging a payment/refund/subscription-activation result.
let warnedMissingSecret = false;

export const verifyMpesaCallbackToken = (req, res, next) => {
  if (!process.env.MPESA_CALLBACK_SECRET) {
    if (!warnedMissingSecret) {
      console.error('[mpesa] MPESA_CALLBACK_SECRET is not set on this server — all M-Pesa callbacks will be rejected until it is configured.');
      warnedMissingSecret = true;
    }
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }

  if (req.params.token !== process.env.MPESA_CALLBACK_SECRET) {
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }

  next();
};
