// Gates /internal/* — service-to-service calls from dukana-admin-backend,
// never a browser or the mobile app. Deliberately its own secret (not
// ADMIN_JWT_SECRET, which doesn't exist in this repo anymore once the admin
// system is extracted; not JWT_SECRET, which is the shop-user secret and
// must never authorize a cross-service call).
let warnedMissingSecret = false;

export const protectInternal = (req, res, next) => {
  if (!process.env.INTERNAL_API_SECRET) {
    if (!warnedMissingSecret) {
      console.error('[internal] INTERNAL_API_SECRET is not set on this server — every internal request will be rejected until it is configured.');
      warnedMissingSecret = true;
    }
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }

  const provided = req.headers.authorization?.replace('Bearer ', '');
  if (!provided || provided !== process.env.INTERNAL_API_SECRET) {
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }

  next();
};
