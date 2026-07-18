import jwt from 'jsonwebtoken';
import AdminUser from '../models/AdminUser.js';

/**
 * Gates /admin/* routes. Verifies against ADMIN_JWT_SECRET (never
 * JWT_SECRET) and requires the `type: 'admin'` claim — a shop-user's token
 * is signed with a different secret entirely, so it fails verification here
 * regardless of payload shape.
 */
export const protectAdmin = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer')) {
    return res.status(401).json({ success: false, message: 'Not authorized, no token' });
  }

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (decoded.type !== 'admin') {
      return res.status(401).json({ success: false, message: 'Not authorized' });
    }

    const admin = await AdminUser.findById(decoded.id).select('-password');
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Admin not found' });
    }
    if (!admin.active) {
      return res.status(401).json({ success: false, message: 'Admin account deactivated' });
    }

    req.admin = admin;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
  }
};

/** Gates admin-account management itself — never grantable via `permissions`, only role. */
export const requireSuperAdmin = (req, res, next) => {
  if (req.admin?.role === 'super_admin') return next();
  return res.status(403).json({ success: false, message: 'Access denied. Super admin only.' });
};

/** Gates a module's routes. super_admin bypasses; 'admin' needs the module key in their permissions array. */
export const requirePermission = (moduleKey) => (req, res, next) => {
  if (req.admin?.role === 'super_admin' || req.admin?.permissions?.includes(moduleKey)) {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Access denied. You do not have permission to access this resource.' });
};
