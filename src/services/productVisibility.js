/**
 * Role-aware shaping of product payloads.
 *
 * Lives outside the controller because it is the single boundary that decides
 * what shop-margin data a staff device is allowed to hold. It is security
 * logic, not formatting, so it is kept small, pure, and directly unit-testable
 * (see tests/productVisibility.test.js).
 */

/**
 * Whether this user should receive commission previews at all.
 *
 * Requires BOTH that the shop publishes commission to staff, and that this
 * particular person is on commission — showing "you earn 45" to someone who
 * isn't eligible promises money that will never arrive.
 */
export const showsCommissionTo = (user) =>
  !!user?.shop?.showStaffCommission && user?.commissionEligible === true;

/** Per-unit commission a seller would earn at `sellingPrice`, or undefined. */
export const previewFor = (config, sellingPrice) => {
  if (!config?.enabled || config.basePrice == null || !Number.isFinite(sellingPrice)) return undefined;
  const excess = Math.max(0, sellingPrice - config.basePrice);
  return Math.round(excess * ((config.employeeSharePercent ?? 100) / 100) * 100) / 100;
};

/**
 * Strips shop-margin-revealing fields from a product for a staff response.
 *
 * Removes `costPrice` everywhere, and drops the whole `commission` object in
 * favour of a derived `commissionPreview` (money per unit). `commission.basePrice`
 * is exactly as sensitive as `costPrice` — it is the owner's floor — so it must
 * never leave the server for a staff role.
 *
 * The share percent is deliberately NOT sent alongside the preview: given both,
 * the floor is trivially recoverable as `sellingPrice − preview ÷ share`, which
 * would defeat the point of stripping it.
 *
 * Mutates and returns `product`, which is expected to be a plain object from
 * `.toObject()` — never a live Mongoose document.
 */
export const sanitizeForStaff = (product, showCommission) => {
  delete product.costPrice;

  const productConfig = product.commission;
  delete product.commission;
  if (showCommission) {
    const preview = previewFor(productConfig, product.sellingPrice);
    if (preview !== undefined) product.commissionPreview = preview;
  }

  if (Array.isArray(product.variants)) {
    product.variants = product.variants.map(({ costPrice, commission, ...rest }) => {
      if (showCommission) {
        // A variant with no config of its own inherits the product's, matching
        // resolveCommissionConfig() in pricingEngine.js — the preview has to
        // agree with what the sale will actually pay out.
        const config = commission?.enabled && commission.basePrice != null ? commission : productConfig;
        const preview = previewFor(config, rest.sellingPrice);
        if (preview !== undefined) rest.commissionPreview = preview;
      }
      return rest;
    });
  }

  return product;
};

/**
 * Reconciles a staff-submitted variant list against what is stored.
 *
 * The write-side counterpart to `sanitizeForStaff`: that decides what a staff
 * device is allowed to *see*, this decides what it is allowed to *set*. Staff
 * maintain the customer-facing side of a variant — name, price, stock, SKU,
 * reorder level — but are never shown its cost price or its commission, so
 * those are carried over from the stored row rather than taken from a form
 * that never held them. Without this, a staff edit would post blanks over the
 * shop's margins, because a product update replaces the whole variant array.
 *
 * Matching is by `_id`, which the client echoes back. A variant with no match
 * is one staff are adding: it brings its own cost like any new record, while
 * commission stays the owner's call.
 *
 * A stored variant the payload omits is kept, not deleted — removing a variant
 * takes away stock and the sale history hanging off it, so it stays an owner
 * act.
 *
 * @param incoming        variants as submitted, or undefined
 * @param storedVariants  plain objects from `product.toObject().variants`
 * @returns the merged list, or undefined when there was nothing to merge (so
 *          the caller can leave the key off the update entirely)
 */
export const mergeVariantsForStaff = (incoming, storedVariants) => {
  if (!Array.isArray(incoming)) return undefined;

  const stored = new Map((storedVariants ?? []).map((v) => [String(v._id), v]));
  const seen = new Set();

  const merged = incoming.map((variant) => {
    const prior = variant._id ? stored.get(String(variant._id)) : undefined;
    if (!prior) {
      const { _id, commission, ...rest } = variant;
      return rest;
    }
    seen.add(String(prior._id));
    return { ...variant, _id: prior._id, costPrice: prior.costPrice, commission: prior.commission };
  });

  for (const [id, prior] of stored) {
    if (!seen.has(id)) merged.push(prior);
  }
  return merged;
};
