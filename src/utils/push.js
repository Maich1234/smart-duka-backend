import { getMessaging } from 'firebase-admin/messaging';
import { getFirebaseAdmin, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';
import Shop from '../models/Shop.js';

/** Fills {{name}}/{{shopName}}/etc from a per-recipient vars object. No-op when the string has no placeholders. */
const interpolate = (str, vars = {}) =>
  typeof str === 'string' ? str.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => vars[key] ?? match) : str;

/** shop may be a populated doc, a bare ObjectId ref, or absent. */
const shopIdOf = (user) => user.shop?._id ?? user.shop;
const shopNameOf = (user) => (typeof user.shop === 'object' ? user.shop?.name : undefined) ?? '';
const shopLocationOf = (user) => (typeof user.shop === 'object' ? user.shop?.county : undefined) ?? '';
const personalizationVars = (user) => ({ name: user.name, shopName: shopNameOf(user), location: shopLocationOf(user) });

/**
 * The shop's logo becomes the notification's large icon/image (Android shows
 * it inline; iOS needs a Notification Service Extension to render it, so it's
 * a no-op there until one exists). The small status-bar glyph is unrelated —
 * Android always masks that one down to a monochrome silhouette from the
 * static app icon, so a shop logo can never appear there.
 *
 * `'logoUrl' in user.shop` distinguishes a populated Shop doc from a bare
 * ObjectId ref (which has no such property) without an extra query in the
 * common case where the caller already populated `shop`.
 */
const resolveShopLogoUrl = async (user) => {
  if (user.shop && typeof user.shop === 'object' && 'logoUrl' in user.shop) {
    return user.shop.logoUrl || undefined;
  }
  const id = shopIdOf(user);
  if (!id) return undefined;
  const shop = await Shop.findById(id).select('logoUrl').lean();
  return shop?.logoUrl || undefined;
};

/** Batched variant of resolveShopLogoUrl for sendPushToUsers — one query for every shop that isn't already populated. */
const resolveShopLogoUrls = async (users) => {
  const byShopId = new Map();
  for (const user of users) {
    if (user.shop && typeof user.shop === 'object' && 'logoUrl' in user.shop) continue;
    const id = shopIdOf(user);
    if (id) byShopId.set(String(id), null);
  }
  if (byShopId.size > 0) {
    const shops = await Shop.find({ _id: { $in: [...byShopId.keys()] } }).select('logoUrl').lean();
    for (const shop of shops) byShopId.set(String(shop._id), shop.logoUrl || undefined);
  }
  return (user) => {
    if (user.shop && typeof user.shop === 'object' && 'logoUrl' in user.shop) return user.shop.logoUrl || undefined;
    const id = shopIdOf(user);
    return id ? byShopId.get(String(id)) ?? undefined : undefined;
  };
};

/**
 * Persists the in-app inbox record for a push, independent of whether the
 * Firebase send itself succeeds — this is what makes the Notifications
 * screen useful even when a device never had push permission granted.
 * Never throws: a logging failure must not block the push.
 */
const persistNotification = async (user, { title, body, data }) =>
  Notification.create({
    user: user._id,
    shop: shopIdOf(user),
    title,
    body,
    data,
    type: data?.type ?? 'general',
  }).catch((err) => console.error('[push] failed to persist notification', err.message));

const persistNotifications = async (records) =>
  Notification.insertMany(records, { ordered: false }).catch((err) =>
    console.error('[push] failed to persist notifications', err.message)
  );

/**
 * Sends a push notification to every device token registered for a user,
 * via the Firebase Admin SDK, and records it in the recipient's in-app
 * inbox. Automatically prunes tokens Firebase reports as
 * invalid/unregistered so the list doesn't grow stale.
 */
export const sendPushToUser = async (user, { title, body, data } = {}) => {
  const vars = personalizationVars(user);
  const finalTitle = interpolate(title, vars);
  const finalBody = interpolate(body, vars);

  await persistNotification(user, { title: finalTitle, body: finalBody, data });

  if (!isFirebaseConfigured()) {
    console.warn('Firebase Admin not configured — skipping push notification');
    return { sent: 0, failed: 0 };
  }

  const tokens = user.fcmTokens || [];
  if (tokens.length === 0) return { sent: 0, failed: 0 };

  const imageUrl = await resolveShopLogoUrl(user);
  const app = getFirebaseAdmin();
  const response = await getMessaging(app).sendEachForMulticast({
    tokens,
    notification: { title: finalTitle, body: finalBody, ...(imageUrl && { imageUrl }) },
    data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
  });

  const invalidTokens = [];
  response.responses.forEach((res, i) => {
    if (!res.success) {
      const code = res.error?.code;
      if (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered') {
        invalidTokens.push(tokens[i]);
      }
    }
  });

  if (invalidTokens.length > 0) {
    await User.updateOne({ _id: user._id }, { $pull: { fcmTokens: { $in: invalidTokens } } });
  }

  return { sent: response.successCount, failed: response.failureCount };
};

const MULTICAST_CHUNK_SIZE = 500; // Firebase's per-call message limit for sendEach

/**
 * Bulk variant of sendPushToUser for campaign-style sends to many users
 * (possibly across many shops) at once. Unlike sendEachForMulticast, this
 * builds one Message per token so title/body can be personalized per
 * recipient via {{name}}/{{shopName}} — needed since a single admin
 * campaign can fan out to users with different names/shops. Still records
 * every recipient's (personalized) inbox entry and prunes invalid tokens.
 */
export const sendPushToUsers = async (users, { title, body, data } = {}) => {
  const payloadData = data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined;

  // Interpolate once per user; reused for both the inbox record and the push.
  const rendered = users.map((user) => {
    const vars = personalizationVars(user);
    return { user, title: interpolate(title, vars), body: interpolate(body, vars) };
  });

  await persistNotifications(
    rendered.map((r) => ({
      user: r.user._id,
      shop: shopIdOf(r.user),
      title: r.title,
      body: r.body,
      data,
      type: data?.type ?? 'general',
    }))
  );

  if (!isFirebaseConfigured()) {
    console.warn('Firebase Admin not configured — skipping push notification');
    return { targeted: users.length, sent: 0, failed: 0 };
  }

  const logoUrlOf = await resolveShopLogoUrls(users);
  const messages = [];
  const tokenOwners = [];
  for (const { user, title: t, body: b } of rendered) {
    const imageUrl = logoUrlOf(user);
    for (const token of user.fcmTokens || []) {
      messages.push({ token, notification: { title: t, body: b, ...(imageUrl && { imageUrl }) }, data: payloadData });
      tokenOwners.push({ token, userId: user._id });
    }
  }
  if (messages.length === 0) return { targeted: users.length, sent: 0, failed: 0 };

  const app = getFirebaseAdmin();
  const messaging = getMessaging(app);

  let sent = 0;
  let failed = 0;
  const invalidByUser = new Map();

  for (let i = 0; i < messages.length; i += MULTICAST_CHUNK_SIZE) {
    const msgChunk = messages.slice(i, i + MULTICAST_CHUNK_SIZE);
    const ownerChunk = tokenOwners.slice(i, i + MULTICAST_CHUNK_SIZE);
    const response = await messaging.sendEach(msgChunk);
    sent += response.successCount;
    failed += response.failureCount;
    response.responses.forEach((res, idx) => {
      if (res.success) return;
      const code = res.error?.code;
      if (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered') {
        const key = String(ownerChunk[idx].userId);
        if (!invalidByUser.has(key)) invalidByUser.set(key, []);
        invalidByUser.get(key).push(ownerChunk[idx].token);
      }
    });
  }

  await Promise.all(
    Array.from(invalidByUser.entries()).map(([userId, tokens]) =>
      User.updateOne({ _id: userId }, { $pull: { fcmTokens: { $in: tokens } } })
    )
  );

  return { targeted: users.length, sent, failed };
};
