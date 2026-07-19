import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { evaluateChatLimits } from '../services/chatLimitsService.js';

// UTC calendar day boundary — same convention as aiController.js's todayStr(),
// used for the AI insight's per-day cache key.
const startOfTodayUTC = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

/**
 * Enforces the active plan's chatLimits (see SubscriptionPlan.chatLimits) on
 * POST /ai/chat. Mounted after requireActiveSubscription (needs
 * req.subscription) and after validate(postChatMessageSchema) (needs a clean
 * req.body.conversationId). A plan with no chatLimits at all (every plan
 * before this feature shipped) is a no-op.
 */
export const enforceChatLimits = async (req, res, next) => {
  try {
    const limits = req.subscription?.plan?.chatLimits;
    if (!limits) return next();

    const shopId = req.user.shop._id;
    const ownerId = req.user._id;
    const isNewConversation = !req.body.conversationId;
    const todayStart = startOfTodayUTC();

    const [activeConversationCount, newConversationsToday, messagesToday] = await Promise.all([
      isNewConversation && limits.maxConversations != null
        ? Conversation.countDocuments({ shop: shopId, owner: ownerId, archived: false })
        : Promise.resolve(0),
      isNewConversation && limits.maxNewConversationsPerDay != null
        ? Conversation.countDocuments({ shop: shopId, owner: ownerId, createdAt: { $gte: todayStart } })
        : Promise.resolve(0),
      limits.maxMessagesPerDay != null
        ? Message.countDocuments({ shop: shopId, kind: 'user_message', createdAt: { $gte: todayStart } })
        : Promise.resolve(0),
    ]);

    const blocked = evaluateChatLimits({
      limits,
      isNewConversation,
      activeConversationCount,
      newConversationsToday,
      messagesToday,
    });

    if (blocked) {
      return res.status(403).json({ success: false, code: blocked.code, message: blocked.message });
    }

    next();
  } catch (err) {
    console.error('[enforceChatLimits] error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to verify chat usage limits.' });
  }
};
