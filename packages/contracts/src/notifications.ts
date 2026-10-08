import type { RunKind, RunStatus } from './index.js';

export type NotificationChannelKind = 'slack_webhook' | 'webhook' | 'email';

/**
 * Events a rule can subscribe to. run.* are queued by the Run completion handler; the others are
 * queued by the monitoring and automation features that detect them.
 */
export type NotificationEventType =
  | 'run.failed'
  | 'run.canceled'
  | 'run.finished'
  | 'automation.failed'
  | 'job.heartbeat_stale'
  | 'job.heartbeat_recovered'
  | 'worker.offline'
  | 'plugin.delivery_stalled';

export const NOTIFICATION_EVENT_TYPES: readonly NotificationEventType[] = [
  'run.failed',
  'run.canceled',
  'run.finished',
  'automation.failed',
  'job.heartbeat_stale',
  'job.heartbeat_recovered',
  'worker.offline',
  'plugin.delivery_stalled',
];

/** Environment variable names a channel may refer to must start with this prefix. */
export const NOTIFICATION_ENV_PREFIX = 'MMT_NOTIFICATION_';
/** Upper bound on email recipients per channel; matches the notification_channels CHECK. */
export const NOTIFICATION_RECIPIENTS_MAX = 50;

/**
 * A destination. The webhook URL and the signing secret are never stored: urlEnv and secretEnv
 * name server environment variables, and configured tells whether those variables are set.
 * projectId null means every Project's rules may use the channel.
 */
export interface NotificationChannel {
  id: string;
  projectId: string | null;
  kind: NotificationChannelKind;
  name: string;
  urlEnv: string | null;
  secretEnv: string | null;
  recipients: string[];
  enabled: boolean;
  configured: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface NotificationChannelCreate {
  projectId?: string | null;
  kind: NotificationChannelKind;
  name: string;
  urlEnv?: string | null;
  secretEnv?: string | null;
  recipients?: string[];
  enabled?: boolean;
}
/** kind and projectId are fixed at creation so existing rules keep a valid channel. */
export type NotificationChannelPatch = Partial<
  Omit<NotificationChannelCreate, 'kind' | 'projectId'>
>;

/**
 * Narrows which events of the selected types are sent. Every given condition must hold; a
 * condition on Runs (runKinds, experimentIds) never matches an event without a Run.
 */
export interface NotificationRuleFilter {
  runKinds?: RunKind[];
  experimentIds?: string[];
  /** Only Runs started by a model automation rule (including their manual Job retries). */
  automationOnly?: boolean;
}
export interface NotificationRule {
  id: string;
  projectId: string;
  channelId: string;
  eventTypes: NotificationEventType[];
  filter: NotificationRuleFilter;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}
export interface NotificationRuleCreate {
  channelId: string;
  eventTypes: NotificationEventType[];
  filter?: NotificationRuleFilter;
  enabled?: boolean;
}
/** Settings are fixed after creation; only enabled can be switched. */
export interface NotificationRulePatch {
  enabled: boolean;
}

export interface NotificationRunSummary {
  id: string;
  name: string;
  kind: RunKind;
  status: RunStatus;
  experimentId: string;
  experimentName: string;
  /** The Run's error, shortened; never execution snapshots, parameters or environment. */
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** The body of a webhook delivery and the source of Slack and email messages. */
export interface NotificationEvent {
  schemaVersion: 1;
  id: string;
  type: NotificationEventType | 'notification.test';
  occurredAt: string;
  title: string;
  project: { id: string; name: string } | null;
  run: NotificationRunSummary | null;
  /** Event-specific scalar values such as a worker or Job id. Never secrets. */
  details: Record<string, string | number | boolean | null>;
  /** Web page about the event, built from MMT_WEB_ORIGIN. */
  url: string | null;
}

export type NotificationDeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed';
export interface NotificationDelivery {
  id: string;
  ruleId: string;
  channelId: string;
  channelName: string;
  channelKind: NotificationChannelKind;
  eventId: string;
  eventType: NotificationEventType;
  title: string;
  runId: string | null;
  status: NotificationDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  /** A failure code such as notification_http_500; never the remote response or the URL. */
  lastError: string | null;
  /** Sent as X-MMT-Delivery so receivers can correlate their logs. */
  sentDeliveryId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}
export interface NotificationTestResult {
  delivered: boolean;
  sentDeliveryId: string | null;
  error: string | null;
}
