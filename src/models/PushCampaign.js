import mongoose from 'mongoose';

// A bulk push notification the super-admin sends to segmented shop owners —
// either immediately or at a future scheduledAt picked up by the
// push-campaign-dispatch cron. Owners who've turned off push notifications
// have no fcmTokens registered, so they're naturally excluded from targeting.
const segmentSchema = new mongoose.Schema({
  type: { type: String, enum: ['all', 'state', 'plan', 'location'], required: true },
  // Access states from subscriptionPricingService.deriveAccess, when type === 'state'.
  states: { type: [String], default: [] },
  // SubscriptionPlan slugs, when type === 'plan'.
  planSlugs: { type: [String], default: [] },
  // When type === 'location': country code (Shop.country) + county display
  // names (Shop.county) to match against.
  country: { type: String, default: null },
  counties: { type: [String], default: [] },
  // Which User roles within the matched shops receive this campaign.
  roles: { type: [String], enum: ['owner', 'staff'], default: ['owner'] },
}, { _id: false });

const statsSchema = new mongoose.Schema({
  targeted: { type: Number, default: 0 },
  sent: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
}, { _id: false });

const pushCampaignSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true, trim: true },
  data: { type: Map, of: String, default: undefined },
  segment: { type: segmentSchema, required: true },
  status: {
    type: String,
    enum: ['scheduled', 'sending', 'sent', 'failed', 'cancelled'],
    default: 'scheduled',
  },
  // null = eligible to send as soon as "Send now" or the dispatcher claims it.
  scheduledAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  stats: { type: statsSchema, default: () => ({}) },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
}, { timestamps: true });

export default mongoose.model('PushCampaign', pushCampaignSchema);
