import { getDepletionAnalytics } from '../services/depletionService.js';

export const getDepletion = async (req, res) => {
  const windowDays = req.query.windowDays ? parseInt(req.query.windowDays, 10) : undefined;
  const data = await getDepletionAnalytics(req.user.shop._id, { windowDays });
  res.json({ success: true, data });
};
