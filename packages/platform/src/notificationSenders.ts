import { createHmac, randomUUID } from 'node:crypto';
import type { NotificationChannelKind, NotificationEvent } from '@mmt/contracts';
import { createEmailNotificationSender, type SmtpSettings } from './emailNotificationSender.js';

// A slow receiver must not hold the outbox dispatcher or the channel test request.
export const NOTIFICATION_DEADLINE_MS = 5000;
// Slack rejects section text over 3000 characters; long Run errors are cut well below that.
const MAX_SLACK_ERROR_LENGTH = 500;
const USER_AGENT = 'mado-model-tracking-notifications';

/** A channel with its environment variables resolved, as the senders need it. */
export interface NotificationDestination {
  kind: NotificationChannelKind;
  name: string;
  url: string | null;
  secret: string | null;
  recipients: string[];
}

/** Stored channel settings that name environment variables instead of holding the values. */
export interface NotificationChannelSettings {
  kind: NotificationChannelKind;
  name: string;
  urlEnv: string | null;
  secretEnv: string | null;
  recipients: string[];
}

/** deliveryId is sent to the receiver (X-MMT-Delivery for webhooks) and stored with the attempt. */
export interface NotificationSender {
  send(channel: NotificationDestination, event: NotificationEvent): Promise<{ deliveryId: string }>;
}

/** Senders by channel kind. A kind without a sender (email while SMTP is unset) cannot deliver. */
export type NotificationSenders = Partial<Record<NotificationChannelKind, NotificationSender>>;

/** A failure with a code that is safe to store and show: never the URL or the remote response. */
export class NotificationSendError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'NotificationSendError';
  }
}

function hasRequiredVariables(
  channel: NotificationChannelSettings,
  environment: NodeJS.ProcessEnv,
): boolean {
  return [channel.urlEnv, channel.secretEnv].every(
    (name) => name === null || Boolean(environment[name]),
  );
}

export function isNotificationChannelConfigured(
  channel: NotificationChannelSettings,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return hasRequiredVariables(channel, environment);
}

export function resolveNotificationDestination(
  channel: NotificationChannelSettings,
  environment: NodeJS.ProcessEnv = process.env,
): NotificationDestination {
  if (!hasRequiredVariables(channel, environment))
    throw new NotificationSendError('notification_channel_unconfigured');
  return {
    kind: channel.kind,
    name: channel.name,
    url: channel.urlEnv === null ? null : environment[channel.urlEnv]!,
    secret: channel.secretEnv === null ? null : environment[channel.secretEnv]!,
    recipients: channel.recipients,
  };
}

/** The X-MMT-Signature value: HMAC-SHA256 of the exact request body with the channel secret. */
export function webhookSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

// Slack treats &, < and > as control characters in mrkdwn.
function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shorten(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/** Incoming webhook payload: `text` is the notification fallback, blocks the formatted message. */
export function slackMessage(event: NotificationEvent): { text: string; blocks: unknown[] } {
  const title = escapeSlack(event.title);
  const heading = event.url ? `*<${event.url}|${title}>*` : `*${title}*`;
  const fields: string[] = [];
  if (event.project) fields.push(`*プロジェクト*\n${escapeSlack(event.project.name)}`);
  if (event.run) {
    fields.push(`*Run*\n${escapeSlack(event.run.name)}`);
    fields.push(`*実験*\n${escapeSlack(event.run.experimentName)}`);
    fields.push(`*種別・状態*\n${event.run.kind} / ${event.run.status}`);
  }
  for (const [key, value] of Object.entries(event.details))
    fields.push(`*${escapeSlack(key)}*\n${escapeSlack(String(value))}`);
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: heading } }];
  // Slack allows at most 10 fields in one section.
  if (fields.length)
    blocks.push({
      type: 'section',
      fields: fields.slice(0, 10).map((text) => ({ type: 'mrkdwn', text })),
    });
  if (event.run?.error)
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`${escapeSlack(shorten(event.run.error, MAX_SLACK_ERROR_LENGTH))}\`\`\``,
      },
    });
  const prefix = event.project ? `[${event.project.name}] ` : '';
  return { text: `${prefix}${event.title}`, blocks };
}

function destinationUrl(channel: NotificationDestination): URL {
  let url: URL;
  try {
    url = new URL(channel.url ?? '');
  } catch {
    throw new NotificationSendError('notification_url_invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new NotificationSendError('notification_url_invalid');
  return url;
}

async function postJson(
  request: { url: URL; body: string; headers: Record<string, string> },
  options: { fetcher: typeof fetch; deadlineMs: number },
): Promise<void> {
  let response: Response;
  try {
    response = await options.fetcher(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...request.headers },
      body: request.body,
      signal: AbortSignal.timeout(options.deadlineMs),
      // A redirect could move the payload to a host the administrator did not choose.
      redirect: 'manual',
    });
  } catch (error) {
    const isTimeout =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new NotificationSendError(
      isTimeout ? 'notification_timeout' : 'notification_destination_unavailable',
    );
  }
  // The response body is not used; release the connection without reading it.
  await response.body?.cancel().catch(() => undefined);
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
    throw new NotificationSendError('notification_redirect_refused');
  if (!response.ok) throw new NotificationSendError(`notification_http_${response.status}`);
}

export function createNotificationSenders(
  options: { fetcher?: typeof fetch; deadlineMs?: number; smtp?: SmtpSettings | null } = {},
): NotificationSenders {
  const transport = {
    fetcher: options.fetcher ?? fetch,
    deadlineMs: options.deadlineMs ?? NOTIFICATION_DEADLINE_MS,
  };
  return {
    slack_webhook: {
      async send(channel, event) {
        const deliveryId = randomUUID();
        await postJson(
          {
            url: destinationUrl(channel),
            body: JSON.stringify(slackMessage(event)),
            headers: {},
          },
          transport,
        );
        return { deliveryId };
      },
    },
    webhook: {
      async send(channel, event) {
        if (!channel.secret) throw new NotificationSendError('notification_channel_unconfigured');
        const deliveryId = randomUUID();
        const body = JSON.stringify(event);
        await postJson(
          {
            url: destinationUrl(channel),
            body,
            headers: {
              'X-MMT-Event': event.type,
              'X-MMT-Event-Id': event.id,
              'X-MMT-Delivery': deliveryId,
              'X-MMT-Signature': webhookSignature(channel.secret, body),
            },
          },
          transport,
        );
        return { deliveryId };
      },
    },
    // Email is sent only when MMT_SMTP_URL is set; otherwise its deliveries fail as unavailable.
    ...(options.smtp ? { email: createEmailNotificationSender({ smtp: options.smtp }) } : {}),
  };
}
