import { randomUUID } from 'node:crypto';
import nodemailer, {
  type NodemailerError,
  type SMTPTransportOptions,
  type Transporter,
} from 'nodemailer';
import { NOTIFICATION_RECIPIENTS_MAX, type NotificationEvent } from '@mmt/contracts';
import {
  NotificationSendError,
  type NotificationDestination,
  type NotificationSender,
} from './notificationSenders.js';

// SMTP needs several round trips (greeting, EHLO, STARTTLS, AUTH, MAIL/RCPT/DATA) and relays often
// delay the greeting on purpose, so it gets twice the 5 seconds the HTTP senders have.
export const EMAIL_NOTIFICATION_DEADLINE_MS = 10_000;
// Long Run errors are cut so a stack trace does not turn the mail into a log dump.
const MAX_EMAIL_ERROR_LENGTH = 2000;
// Mail clients cut long subjects anyway; the rest of the title stays in the body.
const MAX_SUBJECT_LENGTH = 200;
// RFC 5321 limits a forward path to 256 octets; 320 is the usual local@domain upper bound.
const MAX_ADDRESS_LENGTH = 320;
// One address without a display name: no whitespace, list separators or header syntax.
const EMAIL_ADDRESS_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;
// MMT_SMTP_FROM may carry a display name: "mado ML Tracking <mmt@example.com>".
const NAMED_ADDRESS_PATTERN = /^([^<>\r\n]*)<([^<>]+)>$/;

/** The SMTP server and sender address from MMT_SMTP_URL and MMT_SMTP_FROM. */
export interface SmtpSettings {
  /** smtp:// (STARTTLS when offered) or smtps:// (TLS from the start), with optional user:password. */
  url: string;
  from: string;
}

function isEmailAddress(value: string): boolean {
  return value.length <= MAX_ADDRESS_LENGTH && EMAIL_ADDRESS_PATTERN.test(value);
}

function isSenderAddress(value: string): boolean {
  const named = NAMED_ADDRESS_PATTERN.exec(value.trim());
  return isEmailAddress(named ? named[2]!.trim() : value.trim());
}

/**
 * Validates MMT_SMTP_URL and MMT_SMTP_FROM. Returns null when SMTP is not configured, so email
 * channels stay saved but undeliverable. Errors name the variable only: the URL holds a password.
 */
export function parseSmtpSettings(environment: {
  url: string | undefined;
  from: string | undefined;
}): SmtpSettings | null {
  if (!environment.url) {
    if (environment.from) throw new Error('MMT_SMTP_FROM requires MMT_SMTP_URL');
    return null;
  }
  if (!URL.canParse(environment.url)) throw new Error('MMT_SMTP_URL must be a URL');
  const url = new URL(environment.url);
  if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname)
    throw new Error('MMT_SMTP_URL must be smtp://host[:port] or smtps://host[:port]');
  // Query options would reach nodemailer's URL parser and could turn off TLS verification.
  if (url.search) throw new Error('MMT_SMTP_URL must not contain query options');
  if (!environment.from) throw new Error('MMT_SMTP_FROM is required when MMT_SMTP_URL is set');
  if (!isSenderAddress(environment.from))
    throw new Error('MMT_SMTP_FROM must be an email address, optionally with a display name');
  return { url: environment.url, from: environment.from.trim() };
}

function smtpTransportOptions(smtp: SmtpSettings, deadlineMs: number): SMTPTransportOptions {
  const url = new URL(smtp.url);
  return {
    // URL keeps the brackets of an IPv6 literal; the socket needs the bare address.
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    ...(url.port ? { port: Number(url.port) } : {}),
    secure: url.protocol === 'smtps:',
    ...(url.username
      ? {
          auth: {
            user: decodeURIComponent(url.username),
            pass: decodeURIComponent(url.password),
          },
        }
      : {}),
    connectionTimeout: deadlineMs,
    greetingTimeout: deadlineMs,
    socketTimeout: deadlineMs,
    dnsTimeout: deadlineMs,
    // Certificates are always verified; an internal CA is added with NODE_EXTRA_CA_CERTS.
    tls: { rejectUnauthorized: true },
    // The message is built from event fields only; nothing may make the sender read files or URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

function shorten(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/** Subject and plain-text body. Only the listed event fields are used, never unknown properties. */
export function emailMessage(event: NotificationEvent): { subject: string; text: string } {
  const prefix = event.project ? `[${event.project.name}] ` : '';
  // A line break in a Run name must not start a new header line.
  const subject = shorten(`${prefix}${event.title}`.replace(/[\r\n]+/g, ' '), MAX_SUBJECT_LENGTH);
  // Labels match the Slack message so both channels read the same.
  const lines: string[] = [event.title, ''];
  if (event.project) lines.push(`プロジェクト: ${event.project.name}`);
  if (event.run) {
    lines.push(`Run: ${event.run.name}`);
    lines.push(`実験: ${event.run.experimentName}`);
    lines.push(`種別・状態: ${event.run.kind} / ${event.run.status}`);
  }
  for (const [key, value] of Object.entries(event.details)) lines.push(`${key}: ${String(value)}`);
  if (event.run?.error) lines.push('', 'エラー:', shorten(event.run.error, MAX_EMAIL_ERROR_LENGTH));
  if (event.url) lines.push('', event.url);
  lines.push('', `発生日時: ${event.occurredAt}`);
  return { subject, text: `${lines.join('\n')}\n` };
}

function validRecipients(channel: NotificationDestination): string[] {
  const recipients = channel.recipients.map((recipient) => recipient.trim());
  if (
    recipients.length === 0 ||
    recipients.length > NOTIFICATION_RECIPIENTS_MAX ||
    !recipients.every(isEmailAddress)
  )
    throw new NotificationSendError('notification_recipients_invalid');
  return recipients;
}

// Codes only: nodemailer messages and SMTP responses can echo addresses or the server's banner.
function smtpErrorCode(error: unknown): string {
  const failure = error as NodemailerError;
  switch (failure.code) {
    case 'ETIMEDOUT':
      return 'notification_timeout';
    case 'EAUTH':
    case 'ENOAUTH':
      return 'notification_smtp_auth_failed';
    case 'ETLS':
      return 'notification_smtp_tls_failed';
    case 'EENVELOPE':
      return 'notification_smtp_recipients_rejected';
  }
  if (typeof failure.responseCode === 'number') return `notification_smtp_${failure.responseCode}`;
  return 'notification_destination_unavailable';
}

/**
 * Sends a notification as plain-text mail. The transporter is created per sender; nodemailer's
 * SMTP transport opens one connection per message, so a dead relay does not leave a broken pool.
 */
export function createEmailNotificationSender(options: {
  smtp: SmtpSettings;
  deadlineMs?: number;
  /** Replaces the SMTP transport, for tests with nodemailer's JSON or stream transport. */
  transporter?: Transporter;
}): NotificationSender {
  const deadlineMs = options.deadlineMs ?? EMAIL_NOTIFICATION_DEADLINE_MS;
  const transporter =
    options.transporter ??
    nodemailer.createTransport(smtpTransportOptions(options.smtp, deadlineMs));
  return {
    async send(channel, event) {
      const to = validRecipients(channel);
      const deliveryId = randomUUID();
      const { subject, text } = emailMessage(event);
      const sending = transporter.sendMail({
        from: options.smtp.from,
        to,
        subject,
        text,
        headers: {
          'X-MMT-Event': event.type,
          'X-MMT-Event-Id': event.id,
          'X-MMT-Delivery': deliveryId,
        },
      });
      // The socket timeouts bound each step; this bounds the whole exchange of several steps.
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NotificationSendError('notification_timeout')),
          deadlineMs,
        );
      });
      try {
        await Promise.race([
          sending.catch((error: unknown) => {
            throw new NotificationSendError(smtpErrorCode(error));
          }),
          deadline,
        ]);
      } finally {
        clearTimeout(timer);
      }
      return { deliveryId };
    },
  };
}
