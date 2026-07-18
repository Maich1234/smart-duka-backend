import Joi from 'joi';

export const postChatMessageSchema = Joi.object({
  conversationId: Joi.string().hex().length(24).optional(),
  message: Joi.string().trim().min(1).max(2000).required(),
}).unknown(false);
