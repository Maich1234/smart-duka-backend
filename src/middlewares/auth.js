import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import RefreshToken from '../models/RefreshToken.js';

export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password').populate('shop');
      if (!user) {
        return res.status(401).json({ success: false, message: 'User not found' });
      }
      if (!user.isActive) {
        return res.status(401).json({ success: false, message: 'Account deactivated. Please contact owner.' });
      }
      // Access tokens belong to a live refresh session, including after rotation.
      // Legacy tokens must refresh once to acquire a revocable session identity.
      if (!decoded.impersonation && (!decoded.sessionId || !await RefreshToken.exists({ user: user._id, sessionId: decoded.sessionId, revokedAt: null, expiresAt: { $gt: new Date() } }))) {
        return res.status(401).json({ success: false, message: 'Session ended. Refresh your session or sign in again.' });
      }
      req.user = user;
      if (decoded.impersonation) {
        req.impersonation = { adminId: decoded.adminId };
      }
      next();
    } catch (error) {
      console.error(error);
      return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized, no token' });
  }
};

export const ownerOnly = (req, res, next) => {
  if (req.user && req.user.role === 'owner') {
    next();
  } else {
    return res.status(403).json({ success: false, message: 'Access denied. Owner only.' });
  }
};

export const staffOrOwner = (req, res, next) => {
  if (req.user && (req.user.role === 'owner' || req.user.role === 'staff')) {
    next();
  } else {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }
};