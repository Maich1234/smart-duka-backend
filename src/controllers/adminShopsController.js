import Shop from '../models/Shop.js';
import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import PlatformConfig from '../models/PlatformConfig.js';
import { deriveAccess } from '../services/subscriptionPricingService.js';
import { parsePagination } from '../utils/pagination.js';

/** GET /admin/shops — every shop with its subscription/access state and staff count. Read-only. */
export const listShops = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const platform = await PlatformConfig.get();

  const [shops, total] = await Promise.all([
    Shop.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Shop.countDocuments(),
  ]);

  const shopIds = shops.map((s) => s._id);
  const [subscriptions, staffCounts] = await Promise.all([
    Subscription.find({ shop: { $in: shopIds } }).populate('plan').lean(),
    User.aggregate([
      { $match: { shop: { $in: shopIds }, isActive: true } },
      { $group: { _id: '$shop', count: { $sum: 1 } } },
    ]),
  ]);
  const subByShop = new Map(subscriptions.map((s) => [String(s.shop), s]));
  const staffCountByShop = new Map(staffCounts.map((s) => [String(s._id), s.count]));

  const data = shops.map((shop) => {
    const subscription = subByShop.get(String(shop._id)) ?? null;
    return {
      _id: shop._id,
      name: shop.name,
      email: shop.email,
      phone: shop.phone,
      isActive: shop.isActive,
      createdAt: shop.createdAt,
      staffCount: staffCountByShop.get(String(shop._id)) ?? 0,
      plan: subscription?.plan ? { name: subscription.plan.name, slug: subscription.plan.slug } : null,
      access: deriveAccess(subscription, platform.gracePeriodDays),
    };
  });

  res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};
