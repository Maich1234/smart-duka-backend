import User from '../../models/User.js';

export const getProfile = async (req, res) => {
  const user = await User.findById(req.user._id).select('-password').populate('shop');
  res.json({ success: true, data: user });
};

export const updateProfile = async (req, res) => {
  const { name, email, phone } = req.body;
  const user = await User.findById(req.user._id);
  if (!user) return res.status(401).json({ success: false, message: 'Account unavailable.' });
  if ((email !== undefined && email !== user.email) ||
      (phone !== undefined && (phone ?? '') !== (user.phone ?? ''))) {
    return res.status(403).json({ success: false, message: 'Verify the new contact through the contact change form.' });
  }
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 120)) {
    return res.status(400).json({ success: false, message: 'Enter a name between 1 and 120 characters.' });
  }
  if (name !== undefined) {
    user.name = name.trim();
    await user.save();
  }

  res.json({
    success: true,
    data: {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      shop: user.shop,
      // Included so a profile edit can't drop the flag from the client's
      // cached user and silently hide the commission screen until next login.
      commissionEligible: user.commissionEligible,
    },
  });
};