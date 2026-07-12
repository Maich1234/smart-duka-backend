import jwt from 'jsonwebtoken';

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    // Short-lived by design — clients refresh transparently via
    // POST /auth/refresh with their rotating 30-day refresh token.
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  });
};

export default generateToken;