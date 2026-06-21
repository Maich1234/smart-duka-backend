import Rating from '../models/Rating.js';

export const getRatings = async (req, res) => {
  const { staffId, stars, page = 1, limit = 20 } = req.query;
  const query = { shop: req.user.shop._id };
  if (staffId) query.staff = staffId;
  if (stars) query.stars = Number(stars);

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const ratings = await Rating.find(query)
    .populate('staff', 'name')
    .populate('sale', 'invoiceNumber totalAmount createdAt')
    .skip(skip)
    .limit(parseInt(limit))
    .sort({ createdAt: -1 });
  const total = await Rating.countDocuments(query);

  res.json({
    success: true,
    data: ratings,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
  });
};

export const getRatingsSummary = async (req, res) => {
  const shopId = req.user.shop._id;

  const [overall] = await Rating.aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: null, avgStars: { $avg: '$stars' }, totalRatings: { $sum: 1 } } },
  ]);

  const distribution = await Rating.aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: '$stars', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  const byStaff = await Rating.aggregate([
    { $match: { shop: shopId } },
    { $group: { _id: '$staff', avgStars: { $avg: '$stars' }, totalRatings: { $sum: 1 } } },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'staffInfo' } },
    { $unwind: '$staffInfo' },
    { $project: { _id: 0, staffId: '$_id', staffName: '$staffInfo.name', avgStars: 1, totalRatings: 1 } },
    { $sort: { avgStars: -1 } },
  ]);

  res.json({
    success: true,
    data: {
      avgStars: overall?.avgStars || 0,
      totalRatings: overall?.totalRatings || 0,
      distribution: distribution.map((d) => ({ stars: d._id, count: d.count })),
      byStaff,
    },
  });
};
