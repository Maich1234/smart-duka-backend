import mongoose from 'mongoose';
import Sale from '../../models/Sale.js';

// Every other date-bucketing in this codebase (dayWindow, buildBuckets,
// salesAnomalyService) buckets in UTC. This is the first to bucket in
// shop-local time, because "2pm" only means what an owner expects if it's
// Nairobi's 2pm. Safe to hardcode while every shop is Kenya-only
// (Shop.country defaults 'KE', no per-shop timezone field exists) —
// whoever adds non-Kenya shops needs to add Shop.timezone and thread it
// through here instead.
const TIMEZONE = 'Africa/Nairobi';
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const zeroFillHours = (byHour) => {
  const byId = new Map(byHour.map((h) => [h._id, h]));
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    transactionCount: byId.get(hour)?.transactionCount ?? 0,
    revenue: byId.get(hour)?.revenue ?? 0,
  }));
};

const zeroFillWeekdays = (byWeekday) => {
  // MongoDB's $dayOfWeek returns 1=Sunday..7=Saturday.
  const byId = new Map(byWeekday.map((d) => [d._id, d]));
  return WEEKDAY_LABELS.map((label, i) => ({
    weekday: label,
    transactionCount: byId.get(i + 1)?.transactionCount ?? 0,
    revenue: byId.get(i + 1)?.revenue ?? 0,
  }));
};

const maxBy = (arr, key) => arr.reduce((a, b) => (b[key] > a[key] ? b : a));

/**
 * Transaction count + revenue by hour-of-day (0-23) and day-of-week, over a
 * trailing window, bucketed in Africa/Nairobi local time. Backs the chat
 * get_peak_hours tool. `busiestHour`/`busiestWeekday` are precomputed here
 * (not left for Gemini to scan the arrays itself) so the model reports our
 * computed max rather than a re-derived or misread value.
 */
export const getPeakHoursAnalytics = async (shopId, { windowDays = 30 } = {}) => {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const shop = new mongoose.Types.ObjectId(String(shopId));
  const match = { shop, status: { $nin: ['voided', 'refunded'] }, createdAt: { $gte: since } };

  const [byHour, byWeekday] = await Promise.all([
    Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $hour: { date: '$createdAt', timezone: TIMEZONE } },
          transactionCount: { $sum: 1 },
          revenue: { $sum: '$totalAmount' },
        },
      },
    ]),
    Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dayOfWeek: { date: '$createdAt', timezone: TIMEZONE } },
          transactionCount: { $sum: 1 },
          revenue: { $sum: '$totalAmount' },
        },
      },
    ]),
  ]);

  const hours = zeroFillHours(byHour);
  const weekdays = zeroFillWeekdays(byWeekday);

  return {
    windowDays,
    timezone: TIMEZONE,
    hours,
    weekdays,
    busiestHour: maxBy(hours, 'transactionCount'),
    busiestWeekday: maxBy(weekdays, 'transactionCount'),
  };
};
