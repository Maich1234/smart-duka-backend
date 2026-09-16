import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { sendEmail } from '../src/utils/email.js';

/**
 * sendEmail's attachments parameter (Task 11 — quotation PDF emailing).
 * nodemailer.createTransport is a plain, mutable CJS export, so it's the
 * right seam to mock here — sendEmail itself is a named ESM export and
 * cannot be monkey-patched via mock.method (Node's module namespace
 * objects are non-configurable), the same reason mpesaProvider/bankProvider
 * are shaped as mockable objects rather than bare named exports.
 */

process.env.SMTP_HOST ||= 'smtp.test';
process.env.SMTP_USER ||= 'test@duqana.co.ke';

beforeEach(() => mock.restoreAll());

test('sendEmail: passes attachments through to nodemailer sendMail', async () => {
  const sendMail = mock.fn(async () => ({ messageId: '1' }));
  mock.method(nodemailer, 'createTransport', () => ({ sendMail, close() {} }));

  const attachments = [{ filename: 'q.pdf', content: Buffer.from('%PDF-1.4') }];
  await sendEmail('a@b.com', 'Subject', '<p>hi</p>', null, undefined, attachments);

  assert.equal(sendMail.mock.callCount(), 1);
  const mailOptions = sendMail.mock.calls[0].arguments[0];
  assert.equal(mailOptions.attachments, attachments);
  assert.equal(mailOptions.attachments[0].filename, 'q.pdf');
  assert.ok(Buffer.isBuffer(mailOptions.attachments[0].content));
  assert.equal(mailOptions.to, 'a@b.com');
});

test('sendEmail: omits the attachments key entirely when none is given', async () => {
  const sendMail = mock.fn(async () => ({ messageId: '1' }));
  mock.method(nodemailer, 'createTransport', () => ({ sendMail, close() {} }));

  await sendEmail('a@b.com', 'Subject', '<p>hi</p>');

  const mailOptions = sendMail.mock.calls[0].arguments[0];
  assert.equal('attachments' in mailOptions, false);
});
