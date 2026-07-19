// Pure math for spreading a purchase's additional costs (transport,
// packaging, ...) across its line items — used to compute each product's
// "landed" unit cost when updating its running average cost. Never touches
// the database and never mutates the stored purchase record: the raw
// unitCost/totalCost on each item is a historical fact and is never rewritten
// by an allocation method, including if the shop's default method changes
// later (see Purchase.allocationMethod, snapshotted per purchase).
//
// No DB access, so this is directly unit-testable — mirrors pricingEngine.js's
// pure-calculation style.

export const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Splits `amount` across `weights` proportionally, correcting rounding drift
 * on the last non-zero-weight entry so the parts always sum to exactly
 * `amount` (to the cent).
 */
const distributeProportionally = (weights, amount) => {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (!totalWeight || !amount) return weights.map(() => 0);

  const shares = weights.map((w) => round2((w / totalWeight) * amount));
  const drift = round2(amount - shares.reduce((sum, s) => sum + s, 0));
  if (drift !== 0) {
    const lastIdx = weights.reduce((found, w, i) => (w > 0 ? i : found), -1);
    if (lastIdx >= 0) shares[lastIdx] = round2(shares[lastIdx] + drift);
  }
  return shares;
};

/**
 * Returns how much of `additionalCostsTotal` lands on each item, in the same
 * order as `items`, according to `method`:
 *   - 'quantity': spread proportionally to each line's quantity
 *   - 'value':    spread proportionally to each line's totalCost (unitCost × quantity)
 *   - 'none' (or anything else / no cost to spread): every line gets 0
 *
 * @param {{quantity: number, totalCost: number}[]} items
 * @param {number} additionalCostsTotal
 * @param {'quantity'|'value'|'none'} method
 * @returns {number[]} allocated extra cost per item, summing to additionalCostsTotal
 */
export function allocateAdditionalCosts(items, additionalCostsTotal, method) {
  if (!items.length || !additionalCostsTotal || method === 'none') {
    return items.map(() => 0);
  }
  if (method === 'quantity') {
    return distributeProportionally(items.map((i) => i.quantity), additionalCostsTotal);
  }
  if (method === 'value') {
    return distributeProportionally(items.map((i) => i.totalCost), additionalCostsTotal);
  }
  return items.map(() => 0);
}

/**
 * Convenience wrapper: the per-unit landed cost for one item (raw unit cost
 * plus its share of allocated additional costs, if any).
 */
export function landedUnitCost(item, allocatedExtra) {
  if (!item.quantity) return item.unitCost;
  return round2(item.unitCost + allocatedExtra / item.quantity);
}
