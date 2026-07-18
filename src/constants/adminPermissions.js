export const ADMIN_MODULE_PERMISSIONS = [
  { value: 'plans', label: 'Subscription Plans' },
  { value: 'promotions', label: 'Promotions' },
  { value: 'push_campaigns', label: 'Push Notifications' },
  { value: 'platform_config', label: 'Platform Config (M-Pesa)' },
  { value: 'shops', label: 'Shops & Subscriptions' },
  { value: 'audit', label: 'Audit Log' },
];

export const ADMIN_PERMISSION_VALUES = ADMIN_MODULE_PERMISSIONS.map((p) => p.value);
