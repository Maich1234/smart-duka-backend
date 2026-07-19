/**
 * Pure decision logic behind enforceChatLimits — given a plan's chatLimits
 * and the shop's current usage counts, returns the block reason, or null if
 * the request should proceed. Kept DB-free (counts are passed in, not
 * queried here) so it's unit-testable without a live Mongo connection.
 */
export const evaluateChatLimits = ({
  limits,
  isNewConversation,
  activeConversationCount = 0,
  newConversationsToday = 0,
  messagesToday = 0,
}) => {
  if (!limits) return null;

  if (isNewConversation) {
    if (limits.maxConversations != null && activeConversationCount >= limits.maxConversations) {
      return {
        code: 'CHAT_CONVERSATION_LIMIT',
        message: `Your plan allows up to ${limits.maxConversations} conversation${limits.maxConversations === 1 ? '' : 's'}. Delete an old one to start a new one, or upgrade your plan.`,
      };
    }
    if (limits.maxNewConversationsPerDay != null && newConversationsToday >= limits.maxNewConversationsPerDay) {
      return {
        code: 'CHAT_NEW_CONVERSATION_DAILY_LIMIT',
        message: "You've reached today's limit for starting new conversations. Try again tomorrow or upgrade your plan.",
      };
    }
  }

  if (limits.maxMessagesPerDay != null && messagesToday >= limits.maxMessagesPerDay) {
    return {
      code: 'CHAT_MESSAGE_DAILY_LIMIT',
      message: "You've reached today's chat message limit. Try again tomorrow or upgrade your plan.",
    };
  }

  return null;
};
