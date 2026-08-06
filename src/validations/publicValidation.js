import Joi from 'joi';

export const contactMessageSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  email: Joi.string().email().trim().required(),
  phone: Joi.string().trim().max(32).allow('', null).optional(),
  subject: Joi.string().trim().min(1).max(120).required(),
  message: Joi.string().trim().min(1).max(5000).required(),
}).unknown(false);
