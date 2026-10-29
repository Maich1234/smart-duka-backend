import { reserveSubscriptionCheckout } from './reserveSubscriptionCheckout.js';
import { applySuccessfulPayment } from './applySuccessfulPayment.js';
import { logAudit } from '../../../services/auditLogService.js';

/**
 * Activates a subscription at zero cost — a promo/referral discount that
 * fully covers the invoice. Only ever called by subscriptionController after
 * it has independently computed amountDue <= 0 itself (never from a client
 * -supplied amount or a client's own "this is free" claim), so there is
 * nothing to charge and no payment provider is involved.
 *
 * Reservation is serialized per shop, including existing paid attempts.
 * Retries and duplicate clicks are made safe the same way every other
 * subscription payment already is in this codebase: the unique
 * (shop, idempotencyKey) index on SubscriptionPayment rejects a second
 * insert for the same attempt (recovered by the caller exactly like the
 * mpesa/paystack path). applySuccessfulPayment re-reads the payment marker
 * and commits activation plus promotion redemption in one transaction. If
 * the promotion claim loses the race (cap reached or expired), that
 * transaction rolls back and this function marks the just-created
 * payment record failed rather than leaving a phantom "successful" charge
 * with nothing behind it.
 */
export async function activateFreeSubscription({
  shopId, subscription, plan, billingCycle, staffCount, price, promotion, requestedBy, idempotencyKey, req, seatAdjustmentIds,
}) {
  const { payment, created } = await reserveSubscriptionCheckout({
    shop: shopId,
    subscription: subscription._id,
    plan: plan._id,
    billingCycle,
    staffCount,
    amount: 0,
    seatAdjustmentIds,
    additionalCharge: price.additionalCharge ?? 0,
    currency: price.currency,
    provider: 'free',
    status: 'success',
    transactionDate: new Date(),
    promotion: promotion?._id ?? null,
    promoCode: promotion?.code ?? null,
    promoDiscount: price.promoDiscount,
    referralDiscount: price.referralDiscount,
    requestedBy,
    ...(idempotencyKey && { idempotencyKey }),
  });

  if (!created) return { payment, created };

  try {
    await applySuccessfulPayment(payment);
  } catch (err) {
    if (err.code === 'PROMOTION_UNAVAILABLE') {
      payment.status = 'failed';
      payment.errorMessage = err.message;
      await payment.save();
    }
    throw err;
  }

  logAudit({
    shopId,
    userId: requestedBy,
    action: 'subscription.payment.free_activation',
    entityType: 'SubscriptionPayment',
    entityId: payment._id,
    details: {
      planSlug: plan.slug,
      billingCycle,
      promoCode: promotion?.code ?? null,
      promoDiscount: price.promoDiscount,
      referralDiscount: price.referralDiscount,
    },
    req,
  }).catch(() => {});

  return { payment, created };
}
