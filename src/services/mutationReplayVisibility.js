import { presentPurchase } from './purchaseVisibility.js';
import { presentSale } from './saleVisibility.js';
import { sanitizeForStaff, showsCommissionTo } from './productVisibility.js';

/** Replays must use today's visibility policy, including old stored replies. */
export function presentMutationReplay(body, req) {
  if (!body?.data || req.user.role === 'owner') return body;
  const path = req.originalUrl.split('?')[0];
  if (/^\/api\/v1\/sales(?:\/|$)/i.test(path)
    || /^\/api\/v1\/quotations\/[^/]+\/convert\/?$/i.test(path)) {
    return { ...body, data: presentSale(body.data, req.user) };
  }
  if (/^\/api\/v1\/purchases(?:\/|$)/i.test(path)) {
    return { ...body, data: presentPurchase(body.data, req.user) };
  }
  if (/^\/api\/v1\/products(?:\/|$)/i.test(path)) {
    return { ...body, data: sanitizeForStaff({ ...body.data }, showsCommissionTo(req.user)) };
  }
  return body;
}
