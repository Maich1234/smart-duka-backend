import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import User from '../models/User.js';
import PaymentConfig from '../models/PaymentConfig.js';

/**
 * The same four "is this shop actually running yet" signals as the mobile
 * app's GettingStartedChecklist — computed server-side so both the AI chat
 * tool (get_setup_status) and the Setup Guide embed page (/setup/status) use
 * one source of truth instead of two reimplementations.
 */
export async function getSetupStatus(shopId) {
  const [productCount, saleCount, paymentConfig, staffCount] = await Promise.all([
    Product.countDocuments({ shop: shopId }),
    Sale.countDocuments({ shop: shopId }),
    PaymentConfig.findOne({ shop: shopId }).select('mpesa.consumerKey'),
    User.countDocuments({ shop: shopId, role: 'staff' }),
  ]);

  return {
    hasProducts: productCount > 0,
    hasSales: saleCount > 0,
    hasMpesa: !!paymentConfig?.mpesa?.consumerKey,
    hasStaff: staffCount > 0,
  };
}
