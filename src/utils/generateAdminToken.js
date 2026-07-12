import jwt from 'jsonwebtoken';

/**
 * Signs an admin JWT with a secret distinct from JWT_SECRET and a `type:
 * 'admin'` claim, so a shop-user token can never authenticate as admin (and
 * vice versa) even if ADMIN_JWT_SECRET and JWT_SECRET were ever the same
 * value by accident. No refresh-token rotation — low-traffic internal tool,
 * a plain re-login after expiry is fine.
 */
const generateAdminToken = (id) => {
  return jwt.sign({ id, type: 'admin' }, process.env.ADMIN_JWT_SECRET, {
    expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '8h',
  });
};

export default generateAdminToken;
