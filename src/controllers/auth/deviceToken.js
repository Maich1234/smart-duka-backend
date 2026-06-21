import User from '../../models/User.js';

export const registerDeviceToken = async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, message: 'token is required' });
  }
  await User.updateOne({ _id: req.user._id }, { $addToSet: { fcmTokens: token } });
  res.json({ success: true, message: 'Device registered for notifications' });
};

export const unregisterDeviceToken = async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, message: 'token is required' });
  }
  await User.updateOne({ _id: req.user._id }, { $pull: { fcmTokens: token } });
  res.json({ success: true, message: 'Device unregistered' });
};
