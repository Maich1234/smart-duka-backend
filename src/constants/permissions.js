export const ALL_PERMISSIONS = [
  { value: 'view_products', label: 'View Products', category: 'Products' },
  { value: 'create_product', label: 'Create Product', category: 'Products' },
  { value: 'edit_product', label: 'Edit Product', category: 'Products' },
  { value: 'delete_product', label: 'Delete Product', category: 'Products' },
  { value: 'edit_product_stock', label: 'Edit Product Stock', category: 'Products' },
  { value: 'view_sales', label: 'View Sales', category: 'Sales' },
  { value: 'record_sale', label: 'Record Sale', category: 'Sales' },
  { value: 'view_all_sales', label: 'View All Sales (all staff)', category: 'Sales' },
  { value: 'void_sale', label: 'Void Sales', category: 'Sales' },
  { value: 'refund_own_sales', label: 'Refund Own Sales', category: 'Sales' },
  { value: 'refund_all_sales', label: 'Refund Any Sale (all staff)', category: 'Sales' },
  { value: 'manage_staff', label: 'Manage Staff', category: 'Admin' },
  { value: 'edit_shop_settings', label: 'Edit Shop Settings', category: 'Admin' },
  { value: 'manage_expenses', label: 'Manage Expenses', category: 'Admin' },
  { value: 'view_purchases', label: 'View Purchases', category: 'Purchasing' },
  { value: 'create_purchases', label: 'Create Purchases', category: 'Purchasing' },
  { value: 'edit_purchases', label: 'Edit Purchases', category: 'Purchasing' },
  { value: 'delete_purchases', label: 'Delete Purchases', category: 'Purchasing' },
  { value: 'view_purchase_prices', label: 'View Purchase Prices', category: 'Purchasing' },
  { value: 'update_inventory_on_purchase', label: 'Update Inventory', category: 'Purchasing' },
  { value: 'require_purchase_approval', label: 'Require Owner Approval Before Inventory Updates', category: 'Purchasing' },
  { value: 'view_reconciliation', label: 'View Reconciliation', category: 'Reconciliation' },
  // Customer credit. Split four ways on purpose: selling on credit, seeing
  // what you yourself lent out, seeing the whole shop's book, and taking
  // repayments are four different levels of trust, and a duka routinely wants
  // to grant the first and the last without the third. None of them confers
  // the right to change a credit limit, block a customer, edit shop credit
  // settings, import an opening balance or reverse a posted entry — those stay
  // owner-only, so "can collect money" never becomes "can raise the ceiling".
  { value: 'make_credit_sale', label: 'Sell on Credit', category: 'Credit' },
  { value: 'view_own_credit', label: 'View Credit I Gave', category: 'Credit' },
  { value: 'view_all_credit', label: 'View All Customer Credit', category: 'Credit' },
  { value: 'record_credit_payment', label: 'Record Credit Repayments', category: 'Credit' },
];

export const DEFAULT_STAFF_PERMISSIONS = ['view_products', 'record_sale', 'view_sales'];

// Permissions that only make sense alongside another one. Refunding other
// staff members' sales requires being able to see those sales, so granting
// 'refund_all_sales' silently grants 'view_all_sales' too. Same idea for
// purchasing: editing/deleting a purchase requires being able to see it.
export const PERMISSION_DEPENDENCIES = {
  refund_all_sales: ['view_all_sales'],
  edit_purchases: ['view_purchases'],
  delete_purchases: ['view_purchases'],
  // Seeing the whole shop's credit book necessarily includes your own entries.
  // Granted explicitly so an own-scope check never has to special-case the
  // wider grant, and so unticking "all" leaves the narrower view behind rather
  // than silently removing both.
  view_all_credit: ['view_own_credit'],
};

/** Expands a permission list with every dependency it implies (deduplicated). */
export function withImpliedPermissions(permissions = []) {
  const result = new Set(permissions);
  for (const perm of permissions) {
    for (const implied of PERMISSION_DEPENDENCIES[perm] ?? []) {
      result.add(implied);
    }
  }
  return [...result];
}