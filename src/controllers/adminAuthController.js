import AdminUser from '../models/AdminUser.js';
import generateAdminToken from '../utils/generateAdminToken.js';

/** POST /admin/auth/login */
export const login = async (req, res) => {
  const { email, password } = req.body;

  const admin = await AdminUser.findOne({ email });
  if (!admin) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }
  if (!admin.active) {
    return res.status(401).json({ success: false, message: 'Admin account deactivated' });
  }

  const isPasswordMatch = await admin.comparePassword(password);
  if (!isPasswordMatch) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  const token = generateAdminToken(admin._id);
  res.json({
    success: true,
    data: { id: admin._id, name: admin.name, email: admin.email, token },
  });
};

/** GET /admin/auth/me */
export const getProfile = async (req, res) => {
  res.json({ success: true, data: { id: req.admin._id, name: req.admin.name, email: req.admin.email } });
};
