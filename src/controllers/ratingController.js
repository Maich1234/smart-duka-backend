import Rating from '../models/Rating.js';
import { parsePagination, paginatedResult } from '../utils/pagination.js';

/** A comment counts as written only if it survives trimming. */
const HAS_COMMENT = { $nin: [null, ''] };

export const getRatings = async (req, res) => {
  const { staffId, stars, hasComment } = req.query;
  const query = { shop: req.user.shop._id };
  if (staffId) query.staff = staffId;
  if (stars) query.stars = Number(stars);
  // Owners reading feedback want the written ones; the star-only ratings are
  // already summarised by the distribution above the list.
  if (hasComment === 'true') query.comment = HAS_COMMENT;

  const { page, limit, skip } = parsePagination(req.query);
  const result = await paginatedResult(
    { page, limit, skip },
    (s, l) => Rating.find(query)
      .populate('staff', 'name')
      .populate('sale', 'invoiceNumber totalAmount createdAt')
      .skip(s)
      .limit(l)
      .sort({ createdAt: -1 }),
    () => Rating.countDocuments(query),
  );

  res.json({ success: true, ...result });
};

export const getRatingsSummary = async (req, res) => {
  const shopId = req.user.shop._id;
  const now = new Date();
  const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const prev30Start = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // All four are independent, so they cost one round trip rather than four.
  const [[overall], distribution, byStaff, windows] = await Promise.all([
    Rating.aggregate([
      { $match: { shop: shopId } },
      {
        $group: {
          _id: null,
          avgStars: { $avg: '$stars' },
          totalRatings: { $sum: 1 },
          // Written feedback and the sentiment split, counted in the same pass
          // the average already costs.
          withComments: {
            $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$comment', ''] } }, 0] }, 1, 0] },
          },
          positiveCount: { $sum: { $cond: [{ $gte: ['$stars', 4] }, 1, 0] } },
          negativeCount: { $sum: { $cond: [{ $lte: ['$stars', 2] }, 1, 0] } },
          lastRatedAt: { $max: '$createdAt' },
        },
      },
    ]),
    Rating.aggregate([
      { $match: { shop: shopId } },
      { $group: { _id: '$stars', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Rating.aggregate([
      { $match: { shop: shopId } },
      { $group: { _id: '$staff', avgStars: { $avg: '$stars' }, totalRatings: { $sum: 1 } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'staffInfo' } },
      { $unwind: '$staffInfo' },
      { $project: { _id: 0, staffId: '$_id', staffName: '$staffInfo.name', avgStars: 1, totalRatings: 1 } },
      { $sort: { avgStars: -1 } },
    ]),
    // Two 30-day windows so the client can say "up 0.3 on last month" instead
    // of showing an all-time average that never visibly moves.
    Rating.aggregate([
      { $match: { shop: shopId, createdAt: { $gte: prev30Start } } },
      {
        $group: {
          _id: { $gte: ['$createdAt', last30Start] },
          avgStars: { $avg: '$stars' },
          totalRatings: { $sum: 1 },
        },
      },
    ]),
  ]);
  const windowFor = (isRecent) => {
    const w = windows.find((x) => x._id === isRecent);
    return { avgStars: w?.avgStars ?? 0, totalRatings: w?.totalRatings ?? 0 };
  };

  res.json({
    success: true,
    data: {
      avgStars: overall?.avgStars || 0,
      totalRatings: overall?.totalRatings || 0,
      withComments: overall?.withComments || 0,
      positiveCount: overall?.positiveCount || 0,
      negativeCount: overall?.negativeCount || 0,
      lastRatedAt: overall?.lastRatedAt || null,
      last30Days: windowFor(true),
      previous30Days: windowFor(false),
      distribution: distribution.map((d) => ({ stars: d._id, count: d.count })),
      byStaff,
    },
  });
};
