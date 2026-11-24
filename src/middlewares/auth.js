import jwt from 'jsonwebtoken';
import RefreshToken from '../models/RefreshToken.js';
import User from '../models/User.js';
import SupportSession from '../models/SupportSession.js';

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
      if (!decoded.impersonation && (typeof decoded.sessionId !== 'string' || !await RefreshToken.exists({
        user: user._id, sessionId: decoded.sessionId, revokedAt: null, expiresAt: { $gt: new Date() },
      }))) {
        return res.status(401).json({ success: false, message: 'Session expired. Please sign in again.' });
      }
      req.user = user;
      if (decoded.impersonation) {
        const endingSession = req.method === 'POST' && req.baseUrl === '/api/v1/auth' && req.path === '/impersonation/end';
        if (!endingSession && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
          return res.status(403).json({ success: false, message: 'Support sessions are read-only.' });
        }
        if (!decoded.sessionId || !await SupportSession.exists({
          _id: decoded.sessionId, user: user._id, endedAt: null, expiresAt: { $gt: new Date() },
        })) {
          return res.status(401).json({ success: false, message: 'Support session expired.' });
        }
        req.impersonation = { adminId: decoded.adminId, sessionId: decoded.sessionId };
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