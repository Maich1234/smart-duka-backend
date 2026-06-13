import Joi from 'joi';

export const createSaleSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        productId: Joi.string().required(),
        quantity: Joi.number().min(1).required(),
      })
    )
    .min(1)
    .required(),
  paymentMethod: Joi.string().valid('cash', 'mpesa').required(),
}).unknown(false);

export const saleQuerySchema = Joi.object({
  startDate: Joi.date(),
  endDate: Joi.date(),
  staffId: Joi.string(),
  paymentMethod: Joi.string().valid('cash', 'mpesa'),
  page: Joi.number().min(1).default(1),
  limit: Joi.number().min(1).max(100).default(20),
}).unknown(false);