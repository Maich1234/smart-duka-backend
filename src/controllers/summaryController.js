import DailySummary from '../models/DailySummary.js';
import { generateDailySummary } from '../services/dailySummaryService.js';
import { parsePagination } from '../utils/pagination.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * GET /summaries/daily/:date — one day's business summary (owner only).
 * Today's summary is always recomputed for a live view; past days are served
 * from the stored snapshot and generated once on first request if the cron
 * hadn't covered them.
 */
export const getDailySummary = async (req, res) => {
  const date = req.params.date === 'today' ? todayStr() : req.params.date;
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ success: false, message: 'Invalid date — use YYYY-MM-DD or "today".' });
  }
  if (date > todayStr()) {
    return res.status(400).json({ success: false, message: 'Cannot summarize the future.' });
  }

  const shopId = req.user.shop._id;
  let summary;
  if (date === todayStr()) {
    summary = await generateDailySummary(shopId, date);
  } else {
    summary = await DailySummary.findOne({ shop: shopId, date });
    if (!summary) summary = await generateDailySummary(shopId, date);
  }

  res.json({ success: true, data: summary });
};

/** GET /summaries/daily — recent summaries, newest first (owner only). */
export const listDailySummaries = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 14, maxLimit: 60 });
  const filter = { shop: req.user.shop._id };

  const [summaries, total] = await Promise.all([
    DailySummary.find(filter)
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit)
      .select('date totals byMethod refunds voids shifts insights generatedAt'),
    DailySummary.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: summaries,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};
