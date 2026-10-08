/**
 * Conditions the operations monitor watches. Each kind is also the NotificationEventType queued
 * when an alert opens; job.heartbeat_stale additionally queues job.heartbeat_recovered on recovery.
 */
export type OperationsAlertKind = 'job.heartbeat_stale' | 'worker.offline' | 'plugin.delivery_stalled';

export const OPERATIONS_ALERT_KINDS: readonly OperationsAlertKind[] = [
  'job.heartbeat_stale',
  'worker.offline',
  'plugin.delivery_stalled',
];

/**
 * recovered: the condition cleared (heartbeat back, worker answering, events delivered).
 * inactive: the subject is no longer watched (Job ended, worker token revoked or expired, worker
 * silent long enough to count as retired, plugin disabled).
 */
export type OperationsAlertResolution = 'recovered' | 'inactive';

export type OperationsAlertState = 'open' | 'all';

/**
 * One occurrence of a watched condition, from detection to resolution. subjectId is the Job id,
 * `<token id>:<worker id>` for a worker, or the plugin connection id. detail is a snapshot taken
 * when the alert opened; it never holds secrets or remote responses.
 */
export interface OperationsAlert {
  id: string;
  projectId: string;
  kind: OperationsAlertKind;
  subjectId: string;
  openedAt: string;
  resolvedAt: string | null;
  resolution: OperationsAlertResolution | null;
  detail: Record<string, string | number | boolean | null>;
}

/** Delivery state of one plugin's event outbox. Times are ISO UTC; null when there is none. */
export interface PluginOutboxSummary {
  /** Events waiting for their next attempt. */
  pending: number;
  /** Events a dispatcher is sending now. */
  sending: number;
  oldestPendingAt: string | null;
  /** Most attempts made on one undelivered event; 0 when nothing is waiting. */
  maxAttempts: number;
  /** Failure code of the undelivered event with the most attempts; never a remote response. */
  lastError: string | null;
  lastDeliveredAt: string | null;
  /** Whether the monitor judges the plugin stalled (enabled and over the time or attempt limit). */
  stalled: boolean;
}
