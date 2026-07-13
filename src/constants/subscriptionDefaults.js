// Default subscription plans, inserted only when the plans collection is
// empty (see ensureDefaultPlans in subscriptionController). After that the
// database — edited from the super-admin page — is the single source of
// truth; changing these constants does NOT update live pricing.

export const DEFAULT_PLANS = [
  {
    slug: 'starter',
    name: 'Starter',
    tagline: 'Perfect for small shops',
    description: 'Everything a small duka needs to sell, track stock, and get paid.',
    billingType: 'per_staff',
    monthlyPrice: 210,
    yearlyDiscountPercent: 20,
    maxStaff: 9,
    extraStaffPrice: 0,
    trialDays: 30,
    currency: 'KES',
    highlights: [
      'Unlimited sales',
      'Inventory',
      'M-PESA',
      'Reports',
      'Staff management',
      'AI-powered business insights',
      'Offline mode',
      'Free updates',
      'Cloud backup',
    ],
    features: [
      'sales',
      'inventory',
      'mpesa',
      'reports',
      'staff_management',
      'ai_insights',
      'offline',
      'updates',
      'cloud_backup',
    ],
    badge: '',
    priceComparison: 'About the cost of a notebook and a pen each month.',
    active: true,
    displayOrder: 1,
  },
  {
    slug: 'business',
    name: 'Business',
    tagline: 'For growing businesses',
    description: 'Everything in Starter, built for bigger teams at a better price.',
    billingType: 'flat',
    monthlyPrice: 2000,
    yearlyDiscountPercent: 20,
    maxStaff: 20,
    // Each user beyond maxStaff adds this to the monthly price.
    extraStaffPrice: 100,
    trialDays: 30,
    currency: 'KES',
    highlights: [
      'Everything in Starter',
      'Supports up to 20 staff',
      'Centralized staff management',
      'Advanced analytics',
      'Priority support',
      'Better value for larger teams',
    ],
    features: [
      'sales',
      'inventory',
      'mpesa',
      'reports',
      'staff_management',
      'offline',
      'updates',
      'cloud_backup',
      'advanced_analytics',
      'priority_support',
      'ai_insights',
    ],
    badge: 'Recommended',
    priceComparison: 'Save over 50% compared to per-staff pricing.',
    active: true,
    displayOrder: 2,
  },
];

// Marketing copy for the yearly billing option — shown on the pricing screen.
export const YEARLY_OFFER = {
  title: 'Annual Billing',
  perks: ['2 months free', 'Priority support', 'Early access to new features'],
};

// The earned launch offer shown after onboarding completes. The headline is
// composed by the controller from the plan's live trialDays value.
export const LAUNCH_OFFER = {
  title: 'Because you’ve completed your shop setup,',
  headline: (trialDays) => `Your first ${trialDays} days are FREE.`,
  note: 'No commitment. Cancel anytime.',
};
