import Promotion from '../models/Promotion.js';

/** GET /admin/promotions */
export const listPromotions = async (req, res) => {
  const promotions = await Promotion.find().sort({ createdAt: -1 });
  res.json({ success: true, data: promotions });
};

/** POST /admin/promotions */
export const createPromotion = async (req, res) => {
  try {
    const promotion = await Promotion.create(req.body);
    res.status(201).json({ success: true, data: promotion });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: `A promotion with code "${req.body.code}" already exists.` });
    }
    throw err;
  }
};

/** PATCH /admin/promotions/:id — active: false is the soft-delete; there is no hard delete. */
export const updatePromotion = async (req, res) => {
  const promotion = await Promotion.findByIdAndUpdate(
    req.params.id,
    { $set: req.body },
    { new: true, runValidators: true }
  );
  if (!promotion) {
    return res.status(404).json({ success: false, message: 'Promotion not found' });
  }
  res.json({ success: true, data: promotion });
};
