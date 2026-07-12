import PushCampaign from '../models/PushCampaign.js';
import { claimAndDispatchCampaign } from '../services/pushCampaignService.js';
import { parsePagination } from '../utils/pagination.js';

/** GET /admin/push-campaigns */
export const listPushCampaigns = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const [campaigns, total] = await Promise.all([
    PushCampaign.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    PushCampaign.countDocuments(),
  ]);
  res.json({ success: true, data: campaigns, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

/**
 * POST /admin/push-campaigns — always saves as 'scheduled' (scheduledAt may
 * be null, meaning "not yet dispatched"). Creating never sends by itself —
 * the client follows up with POST /:id/send for an immediate send, or lets
 * the dispatcher cron pick it up once scheduledAt arrives.
 */
export const createPushCampaign = async (req, res) => {
  const campaign = await PushCampaign.create({ ...req.body, createdBy: req.admin._id });
  res.status(201).json({ success: true, data: campaign });
};

/** POST /admin/push-campaigns/:id/send — "Send now"; also the cron's dispatch path. */
export const sendPushCampaign = async (req, res) => {
  const campaign = await claimAndDispatchCampaign(req.params.id);
  if (!campaign) {
    return res.status(409).json({ success: false, message: 'Campaign is not in a sendable state (already sending, sent, or cancelled).' });
  }
  res.json({ success: true, data: campaign });
};

/** PATCH /admin/push-campaigns/:id/cancel — only while still scheduled and unclaimed. */
export const cancelPushCampaign = async (req, res) => {
  const campaign = await PushCampaign.findOneAndUpdate(
    { _id: req.params.id, status: 'scheduled' },
    { $set: { status: 'cancelled' } },
    { new: true }
  );
  if (!campaign) {
    return res.status(409).json({ success: false, message: 'Campaign can only be cancelled while scheduled.' });
  }
  res.json({ success: true, data: campaign });
};
