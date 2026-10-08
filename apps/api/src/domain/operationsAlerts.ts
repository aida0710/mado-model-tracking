import { z } from 'zod';
import type { OperationsAlertKind, OperationsAlertResolution } from '@mmt/contracts';
import { JOB_HEARTBEAT_STALE_SECONDS, WORKER_OFFLINE_SECONDS } from './workerLiveness.js';

// Agreed thresholds (decisions.md): a plugin is stalled when an event stays undelivered for
// 15 minutes, or when one event has been attempted 5 times without success.
export const PLUGIN_STALL_SECONDS = 900;
export const PLUGIN_STALL_ATTEMPTS = 5;
// A worker silent for a week is treated as retired (renamed or removed host), so it neither
// opens a new alert nor keeps an old one open forever.
export const WORKER_RETIRED_SECONDS = 7 * 24 * 60 * 60;

// The header badge lists open alerts; history views page through at most 200 at a time.
const DEFAULT_ALERT_PAGE_SIZE = 50;
const MAX_ALERT_PAGE_SIZE = 200;

export const operationsAlertQuerySchema = z.strictObject({
  state: z.enum(['open', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(MAX_ALERT_PAGE_SIZE).default(DEFAULT_ALERT_PAGE_SIZE),
});

export type OperationsAlertDetail = Record<string, string | number | boolean | null>;

/** A subject the monitor watches this tick. isAlerting tells whether it should have an open alert. */
export interface MonitoredSubject {
  kind: OperationsAlertKind;
  subjectId: string;
  projectId: string;
  isAlerting: boolean;
  detail: OperationsAlertDetail;
}

export interface OpenAlertReference {
  id: string;
  kind: OperationsAlertKind;
  subjectId: string;
}

export interface AlertResolution<Subject extends MonitoredSubject> {
  alert: OpenAlertReference;
  resolution: OperationsAlertResolution;
  /** The subject as read this tick; absent when it is no longer watched. */
  subject?: Subject;
}

export interface AlertChangePlan<Subject extends MonitoredSubject> {
  open: Subject[];
  resolve: AlertResolution<Subject>[];
}

export function isJobHeartbeatStale(heartbeatAgeSeconds: number): boolean {
  return heartbeatAgeSeconds > JOB_HEARTBEAT_STALE_SECONDS;
}

export function isWorkerOffline(silentSeconds: number): boolean {
  return silentSeconds > WORKER_OFFLINE_SECONDS;
}

export function isWorkerRetired(silentSeconds: number): boolean {
  return silentSeconds > WORKER_RETIRED_SECONDS;
}

/**
 * Undelivered includes events being sent: a retry in flight is still part of the backlog, so an
 * alert does not resolve and reopen each time the dispatcher claims the event.
 */
export function isPluginDeliveryStalled(backlog: {
  oldestUndeliveredAgeSeconds: number | null;
  maxAttempts: number;
}): boolean {
  if (backlog.oldestUndeliveredAgeSeconds === null) return false;
  return (
    backlog.oldestUndeliveredAgeSeconds > PLUGIN_STALL_SECONDS ||
    backlog.maxAttempts >= PLUGIN_STALL_ATTEMPTS
  );
}

function subjectKey(reference: { kind: OperationsAlertKind; subjectId: string }): string {
  return `${reference.kind}\u0000${reference.subjectId}`;
}

/**
 * Compares the open alerts with the subjects read this tick. An alerting subject without an open
 * alert opens one; an open alert whose subject stopped alerting resolves as recovered, and one
 * whose subject is no longer watched resolves as inactive.
 */
export function planAlertChanges<Subject extends MonitoredSubject>(
  openAlerts: readonly OpenAlertReference[],
  subjects: readonly Subject[],
): AlertChangePlan<Subject> {
  const subjectsByKey = new Map(subjects.map((subject) => [subjectKey(subject), subject]));
  const openKeys = new Set(openAlerts.map(subjectKey));
  const resolve: AlertResolution<Subject>[] = [];
  for (const alert of openAlerts) {
    const subject = subjectsByKey.get(subjectKey(alert));
    if (!subject) resolve.push({ alert, resolution: 'inactive' });
    else if (!subject.isAlerting) resolve.push({ alert, resolution: 'recovered', subject });
  }
  const open = subjects.filter(
    (subject) => subject.isAlerting && !openKeys.has(subjectKey(subject)),
  );
  return { open, resolve };
}
