import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { verifyCsrf } from './csrf.js';

export const protect = async (req, res, next) => {
  let token;
  let fromCookie = false;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies?.access_token) {
    // Web sessions carry no Authorization header — the access token travels
    // in an HttpOnly cookie instead. Same token, same verification, same
    // req.user either way; only the transport differs.
    token = req.cookies.access_token;
    fromCookie = true;
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized, no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password').populate('shop');
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'Account deactivated. Please contact owner.' });
    }
    req.user = user;
    if (decoded.impersonation) {
      req.impersonation = { adminId: decoded.adminId };
    }
    // Ambient cookie credentials need CSRF protection on mutating requests;
    // an Authorization header never rides along involuntarily, so Bearer
    // requests skip straight to next().
    if (fromCookie) {
      return verifyCsrf(req, res, next);
    }
    next();
  } catch (error) {
    console.error(error);
    return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
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