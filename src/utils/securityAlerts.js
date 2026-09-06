import { sendPushToUser } from './push.js';
import { sendEmail } from './email.js';
import { renderSecurityAlertEmail } from './emailTemplates.js';

// System-generated staff addresses (see utils/staffEmailSlug.js) are never
// real inboxes — sending an alert there would just fail or vanish silently.
const isSystemGeneratedAddress = (email) => (email || '').toLowerCase().endsWith('.duqana.app');

const ipOf = (req) => req?.ip ?? req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim();

const EVENT_COPY = {
  password_change: {
    subject: 'Your DuQana password was changed',
    title: 'Password changed',
    body: 'Your account password was just changed.',
    heading: 'Your password was changed',
    message: 'This confirms your DuQana account password was changed just now. If this was you, no action is needed.',
  },
  password_change_failed: {
    subject: 'Failed attempt to change your DuQana password',
    title: 'Failed password change attempt',
    body: 'Someone entered the wrong current password while trying to change your password.',
    heading: 'Someone tried to change your password',
    message: 'A password change was attempted on your DuQana account, but the current password entered was incorrect. If this was not you, change your password now.',
    severity: 'warning',
  },
  profile_updated: {
    subject: 'Your DuQana account details were changed',
    title: 'Account details changed',
    body: 'Your account contact details were just updated.',
    heading: 'Your account details were changed',
    message: 'This confirms a change to your DuQana account contact details.',
  },
  staff_account_updated: {
    subject: 'Your DuQana account was updated by your shop owner',
    title: 'Account updated by your shop owner',
    body: 'Your shop owner just made changes to your account.',
    heading: 'Your account was updated',
    message: 'Your shop owner made the following changes to your DuQana staff account.',
  },
  permissions_updated: {
    subject: 'Your DuQana account permissions were changed',
    title: 'Permissions changed',
    body: 'Your shop owner just changed what you can access.',
    heading: 'Your account permissions were changed',
    message: 'Your shop owner updated what your DuQana staff account is allowed to access.',
  },
  force_logout: {
    subject: 'You were signed out of DuQana',
    title: 'Signed out',
    body: 'You were signed out by your shop owner.',
    heading: 'You were signed out',
    message: 'Your shop owner ended your active DuQana session on this device.',
  },
  mpesa_config_updated: {
    subject: 'Your DuQana M-Pesa payment settings were changed',
    title: 'M-Pesa settings changed',
    body: "Your shop's M-Pesa payment configuration was just updated.",
    heading: 'M-Pesa payment settings changed',
    message: "This confirms a change to your shop's M-Pesa payment configuration on DuQana.",
  },
  mpesa_disconnected: {
    subject: 'Your DuQana M-Pesa connection was removed',
    title: 'M-Pesa disconnected',
    body: "Your shop's M-Pesa payment connection was just removed.",
    heading: 'M-Pesa was disconnected',
    message: "This confirms your shop's M-Pesa payment connection on DuQana was disconnected.",
  },
};

/**
 * Alerts a user — in-app inbox + push, and email — about a change or
 * attempted change to one of their account's security settings. Never
 * throws: this is a notification side-channel, not the primary operation,
 * and must not fail the request that triggered it. Callers still need to
 * `await` it before `res.json()` (Vercel freezes the invocation the moment
 * the response is flushed, so anything left dangling after it never runs).
 *
 * @param {import('mongoose').Document} user - recipient (needs _id, name, shop, fcmTokens)
 * @param {keyof EVENT_COPY} eventKey
 * @param {Object} [opts]
 * @param {string} [opts.detail] - extra sentence appended to the push/email body (e.g. what changed)
 * @param {import('express').Request} [opts.req] - used to read the IP for the email
 * @param {string} [opts.email] - override recipient email (e.g. the *previous* address on an email change,
 *   so the real owner is warned even if an attacker is the one making the change). Defaults to user.email.
 * @param {boolean} [opts.skipPush] - true when the caller already sent its own push (e.g. force-logout,
 *   whose payload needs a client-recognized `type` this helper doesn't know about)
 */
export async function notifySecurityEvent(user, eventKey, { detail, req, email, skipPush = false } = {}) {
  const copy = EVENT_COPY[eventKey];
  if (!copy) {
    console.error('[securityAlerts] unknown event', eventKey);
    return;
  }

  if (!skipPush) {
    await sendPushToUser(user, {
      title: copy.title,
      body: detail ? `${copy.body} ${detail}` : copy.body,
      data: { type: 'security_alert', event: eventKey },
    }).catch((err) => console.error('[securityAlerts] push failed', eventKey, err.message));
  }

  const recipientEmail = email !== undefined ? email : user.email;
  if (recipientEmail && !isSystemGeneratedAddress(recipientEmail)) {
    try {
      const { html, text } = renderSecurityAlertEmail({
        name: user.name,
        heading: copy.heading,
        message: detail ? `${copy.message} ${detail}` : copy.message,
        when: new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }),
        ip: ipOf(req),
        severity: copy.severity,
      });
      await sendEmail(recipientEmail, copy.subject, html, text);
    } catch (err) {
      console.error('[securityAlerts] email failed', eventKey, recipientEmail, err.message);
    }
  }
}
