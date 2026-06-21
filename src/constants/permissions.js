export const ALL_PERMISSIONS = [
  { value: 'view_products', label: 'View Products', category: 'Products' },
  { value: 'create_product', label: 'Create Product', category: 'Products' },
  { value: 'edit_product', label: 'Edit Product', category: 'Products' },
  { value: 'delete_product', label: 'Delete Product', category: 'Products' },
  { value: 'edit_product_stock', label: 'Edit Product Stock', category: 'Products' },
  { value: 'view_sales', label: 'View Sales', category: 'Sales' },
  { value: 'record_sale', label: 'Record Sale', category: 'Sales' },
  { value: 'view_all_sales', label: 'View All Sales (all staff)', category: 'Sales' },
  { value: 'manage_staff', label: 'Manage Staff', category: 'Admin' },
  { value: 'edit_shop_settings', label: 'Edit Shop Settings', category: 'Admin' },
  { value: 'manage_expenses', label: 'Manage Expenses', category: 'Admin' },
];

export const DEFAULT_STAFF_PERMISSIONS = ['view_products', 'record_sale', 'view_sales'];