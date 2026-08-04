import User from '../../models/User.js';

export const getProfile = async (req, res) => {
  const user = await User.findById(req.user._id).select('-password').populate('shop');
  res.json({ success: true, data: user });
};

export const updateProfile = async (req, res) => {
  const { name, email, phone } = req.body;
  const user = await User.findById(req.user._id);

  if (name) user.name = name;
  if (email) user.email = email;
  if (phone) user.phone = phone;

  await user.save();

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