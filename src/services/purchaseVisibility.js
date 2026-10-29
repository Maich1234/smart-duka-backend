/** Shared response policy for purchase rows and related summaries. */
export const canViewPurchasePrices = user => user.role === 'owner' || user.permissions?.includes('view_purchase_prices');

export function presentPurchase(purchase, user) {
  const obj = purchase.toObject ? purchase.toObject() : { ...purchase };
  if (canViewPurchasePrices(user)) return obj;
  obj.items = (obj.items ?? []).map(({ unitCost, totalCost, ...rest }) => rest);
  obj.additionalCosts = (obj.additionalCosts ?? []).map(({ amount, ...rest }) => rest);
  delete obj.productsTotal;
  delete obj.additionalCostsTotal;
  delete obj.grandTotal;
  return obj;
}
