import mpesaProvider from './mpesaProvider.js';
import cardProvider from './cardProvider.js';
import bankProvider from './bankProvider.js';

// Payment provider registry. Every provider implements:
//   key, label, available,
//   charge({ phoneNumber, amount, reference, description, callbackUrl })
//     → { providerRef, merchantRequestId?, phoneNumber? }
//   parseCallback(body) → { providerRef, success, resultCode, resultDesc, receipt }
// Adding a processor = writing one module and registering it here.
const providers = {
  [mpesaProvider.key]: mpesaProvider,
  [cardProvider.key]: cardProvider,
  [bankProvider.key]: bankProvider,
};

export function getPaymentProvider(name) {
  const provider = providers[name];
  if (!provider) {
    const err = new Error(`Unknown payment provider: ${name}`);
    err.code = 'PROVIDER_UNKNOWN';
    throw err;
  }
  return provider;
}

/** For "choose how to pay" UIs — every provider with its availability. */
export function listPaymentProviders() {
  return Object.values(providers).map(({ key, label, available }) => ({ key, label, available }));
}
