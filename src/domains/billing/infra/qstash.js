// The SDK is imported on first use rather than at module scope. This file is
// reachable from the route barrel via billingEventController, so a static
// import cost ~62ms of every cold start — including logins and sales — to
// serve the billing-events dispatch route and the publish path alone. The
// config guards below deliberately run *before* the import, so a deployment
// without QSTASH_* env vars never pays for the SDK at all.

let client;
let receiver;

export const isQStashConfigured = () => Boolean(process.env.QSTASH_TOKEN);

/** Lazily constructs the publish client so the server can still boot before QSTASH_* env vars are configured. */
export const getQStashClient = async () => {
  if (client) return client;
  if (!process.env.QSTASH_TOKEN) {
    throw new Error('QSTASH_TOKEN is not configured');
  }
  const { Client } = await import('@upstash/qstash');
  client = new Client({ token: process.env.QSTASH_TOKEN });
  return client;
};

/** Lazily constructs the inbound-signature verifier used by the billing-events dispatch route. */
export const getQStashReceiver = async () => {
  if (receiver) return receiver;
  const { QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY } = process.env;
  if (!QSTASH_CURRENT_SIGNING_KEY || !QSTASH_NEXT_SIGNING_KEY) {
    throw new Error('QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY are not configured');
  }
  const { Receiver } = await import('@upstash/qstash');
  receiver = new Receiver({
    currentSigningKey: QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: QSTASH_NEXT_SIGNING_KEY,
  });
  return receiver;
};
