import Joi from 'joi';

// An item needs EITHER a productId (catalog line, name/price resolved
// server-side from the Product) OR a free-text name (custom line) — never
// neither. unitPrice is required for a custom line since there is no catalog
// price to fall back on; it's optional for a catalog line, matching how
// createSaleSchema already treats unitPrice as an override.
const quotationItemSchema = Joi.object({
  productId: Joi.string().hex().length(24).optional(),
  name: Joi.string().trim().max(120).optional(),
  description: Joi.string().trim().max(300).allow('').optional(),
  // min(0.001), not positive() — matches the model's own floor exactly, so a
  // sub-floor quantity 400s cleanly here instead of reaching Mongoose and 500ing.
  quantity: Joi.number().min(0.001).required(),
  // Required only for a custom line (no productId) — a catalog line has no
  // price to require here, since the controller resolves it from the
  // Product. Joi's sibling-reference form of .when(), not the schema-shaped
  // form: referencing 'productId' by key name is the well-documented,
  // reliably-behaving variant.
  unitPrice: Joi.number().min(0).when('productId', {
    is: Joi.exist(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
})
  .or('productId', 'name');

export const createQuotationSchema = Joi.object({
  customerId: Joi.string().hex().length(24).required(),
  items: Joi.array().items(quotationItemSchema).min(1).required(),
  notes: Joi.string().trim().max(500).allow('').optional(),
  validUntil: Joi.date().iso().required(),
}).unknown(false);

export const updateQuotationSchema = createQuotationSchema;
