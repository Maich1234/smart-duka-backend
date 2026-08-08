import Joi from 'joi';

export const cashierReconciliationQuerySchema = Joi.object({
  period: Joi.string().valid('day', 'week', 'month').default('day'),
  date: Joi.date().optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  // Unlike GET /shifts and GET /sales (which pass staffId into a Mongoose
  // .find() that casts and rejects it with a clean 400), reconciliationService
  // builds a raw `new mongoose.Types.ObjectId(staffId)` for its aggregation
  // pipeline — an un-castable value would throw a raw BSONError instead of a
  // validation error, so it's constrained here at the boundary.
  staffId: Joi.string().hex().length(24).optional(),
}).unknown(false);

export const monthlyReconciliationQuerySchema = Joi.object({
  date: Joi.date().optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
}).unknown(false);
