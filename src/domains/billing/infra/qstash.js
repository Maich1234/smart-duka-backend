import { Client, Receiver } from '@upstash/qstash';

let client;
let receiver;

export const isQStashConfigured = () => Boolean(process.env.QSTASH_TOKEN);

/** Lazily constructs the publish client so the server can still boot before QSTASH_* env vars are configured. */
export const getQStashClient = () => {
  if (client) return client;
  if (!process.env.QSTASH_TOKEN) {
    throw new Error('QSTASH_TOKEN is not configured');
  }
  client = new Client({ token: process.env.QSTASH_TOKEN });
  return client;
};

/** Lazily constructs the inbound-signature verifier used by the billing-events dispatch route. */
export const getQStashReceiver = () => {
  if (receiver) return receiver;
  const { QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY } = process.env;
  if (!QSTASH_CURRENT_SIGNING_KEY || !QSTASH_NEXT_SIGNING_KEY) {
    throw new Error('QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY are not configured');
  }
  receiver = new Receiver({
    currentSigningKey: QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: QSTASH_NEXT_SIGNING_KEY,
  });
  return receiver;
};
