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
];

export const DEFAULT_STAFF_PERMISSIONS = ['view_products', 'record_sale', 'view_sales'];

// Permissions that only make sense alongside another one. Refunding other
// staff members' sales requires being able to see those sales, so granting
// 'refund_all_sales' silently grants 'view_all_sales' too.
export const PERMISSION_DEPENDENCIES = {
  refund_all_sales: ['view_all_sales'],
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