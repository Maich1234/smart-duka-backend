import express from 'express';
import rateLimit from 'express-rate-limit';
import { getBusinessInsight } from '../../controllers/aiController.js';
import {
  postChatMessage,
  listConversations,
  getConversation,
  archiveConversation,
} from '../../controllers/aiChatController.js';
import { protect, ownerOnly } from '../../middlewares/auth.js';
import { requireActiveSubscription } from '../../middlewares/requireActiveSubscription.js';
import { requireFeature } from '../../middlewares/requireFeature.js';
import { requireAiEnabled } from '../../middlewares/requireAiEnabled.js';
import { enforceChatLimits } from '../../middlewares/enforceChatLimits.js';
import validate from '../../middlewares/validate.js';
import idempotency from '../../middlewares/idempotency.js';
import { createRateLimitStore } from '../../utils/rateLimitStore.js';
import { postChatMessageSchema } from '../../validations/aiChatValidation.js';

const router = express.Router();

router.use(protect, ownerOnly);

router.get('/insight', requireActiveSubscription, requireFeature('ai_insights'), requireAiEnabled, getBusinessInsight);

// /ai/insight has no rate limiter because its per-(shop,day,fingerprint)
// cache is self-limiting. A chat turn has no equivalent cap — every message
// is fresh and can trigger up to 5 Gemini calls (see chatOrchestrator's
// MAX_TOOL_ROUNDS) — so this is only the second AI route to need one.
const chatLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 15 * 60 * 1000,
  max: 20,
  store: createRateLimitStore('ai-chat'),
  message: { success: false, message: 'Too many chat messages. Please wait a few minutes and try again.' },
});

// idempotency: a client-side timeout-then-retry on a multi-round tool-calling
// turn would otherwise silently re-run the whole loop and burn a second full
// round of Gemini spend for the same question.
router.post('/chat', requireActiveSubscription, requireFeature('ai_insights'), requireAiEnabled, chatLimiter, idempotency, validate(postChatMessageSchema), enforceChatLimits, postChatMessage);
router.get('/chat/conversations', requireActiveSubscription, listConversations);
router.get('/chat/conversations/:id', requireActiveSubscription, getConversation);
// Not subscription-gated — a lapsed owner can still archive their own data.
router.delete('/chat/conversations/:id', archiveConversation);

export default router;
