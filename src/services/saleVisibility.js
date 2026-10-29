/** Sales carry accounting cost snapshots; staff responses must not expose them.
 * Commission history is visible only for the viewer's own sales when enabled
 * by the shop, including historical earnings after eligibility changes. */
export function presentSale(sale, user) {
  const obj = sale.toObject ? sale.toObject() : { ...sale };
  if (user.role === 'owner') return obj;
  const ownSale = String(obj.staff?._id ?? obj.staff) === String(user._id);
  const showCommission = user.shop?.showStaffCommission && ownSale;
  delete obj.stockMovements;
  delete obj.creditRevision;
  if (!showCommission) delete obj.totalCommission;
  obj.items = (obj.items ?? []).map(item => {
    const { unitCost, costTotal, costEstimated, ...visible } = item;
    if (!showCommission) delete visible.commissionAmount;
    return visible;
  });
  return obj;
}
