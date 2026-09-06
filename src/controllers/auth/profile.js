import User from '../../models/User.js';
import { logAudit } from '../../services/auditLogService.js';
import { notifySecurityEvent } from '../../utils/securityAlerts.js';

export const getProfile = async (req, res) => {
  const user = await User.findById(req.user._id).select('-password').populate('shop');
  res.json({ success: true, data: user });
};

export const updateProfile = async (req, res) => {
  const { name, email, phone } = req.body;
  const user = await User.findById(req.user._id);
  const previousEmail = user.email;

  const changes = [];
  if (name) user.name = name;
  if (email && email !== user.email) {
    changes.push(`email changed to ${email}`);
    user.email = email;
  }
  if (phone && phone !== user.phone) {
    changes.push(`phone number changed to ${phone}`);
    user.phone = phone;
  }

  await user.save();

  if (changes.length > 0) {
    await logAudit({ shopId: user.shop, userId: user._id, action: 'auth.profile_update', details: { changes }, req });
    // Alert the pre-change email — if an attacker is the one making this
    // change, that's the address the real account owner still controls.
    await notifySecurityEvent(user, 'profile_updated', { req, detail: changes.join(', '), email: previousEmail || user.email });
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