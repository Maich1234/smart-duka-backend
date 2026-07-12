import User from '../../models/User.js';
import generateToken from '../../utils/generateToken.js';
import { issueRefreshToken } from '../../services/refreshTokenService.js';

export const login = async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).populate('shop');
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  if (!user.isActive) {
    return res.status(401).json({ success: false, message: 'Account deactivated. Please contact owner.' });
  }

  if (!user.isEmailVerified) {
    return res.status(401).json({ success: false, message: 'Please verify your email before logging in.' });
  }

  const isPasswordMatch = await user.comparePassword(password);
  if (!isPasswordMatch) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  const token = generateToken(user._id);
  // Long-lived rotating refresh token so short access tokens never log a
  // cashier out mid-shift. Older clients that ignore this field keep working
  // (they just get signed out when the access token expires).
  const refreshToken = await issueRefreshToken(user._id);
  const userResponse = user.toObject();
  delete userResponse.password;

  res.json({ success: true, data: { ...userResponse, token, refreshToken } });
};