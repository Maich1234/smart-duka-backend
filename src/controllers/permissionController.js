import { ALL_PERMISSIONS } from '../constants/permissions.js';

export const getAllPermissions = (req, res) => {
  res.json({ success: true, data: ALL_PERMISSIONS });
};