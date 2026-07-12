import SubscriptionPlan from '../models/SubscriptionPlan.js';

/** GET /admin/plans — every plan, including inactive ones, by display order. */
export const listPlans = async (req, res) => {
  const plans = await SubscriptionPlan.find().sort({ displayOrder: 1 });
  res.json({ success: true, data: plans });
};

/** POST /admin/plans */
export const createPlan = async (req, res) => {
  try {
    const plan = await SubscriptionPlan.create(req.body);
    res.status(201).json({ success: true, data: plan });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: `A plan with slug "${req.body.slug}" already exists.` });
    }
    throw err;
  }
};

/** PATCH /admin/plans/:id — active: false is the soft-delete; there is no hard delete. */
export const updatePlan = async (req, res) => {
  const plan = await SubscriptionPlan.findByIdAndUpdate(
    req.params.id,
    { $set: req.body },
    { new: true, runValidators: true }
  );
  if (!plan) {
    return res.status(404).json({ success: false, message: 'Plan not found' });
  }
  res.json({ success: true, data: plan });
};
