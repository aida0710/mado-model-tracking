import type { OperationsAlert } from '@mmt/contracts';
import type { PoolClient } from 'pg';
import { transaction, type Database } from '../db/database.js';
import {
  isJobHeartbeatStale,
  isPluginDeliveryStalled,
  isWorkerOffline,
  isWorkerRetired,
  planAlertChanges,
  type MonitoredSubject,
} from '../domain/operationsAlerts.js';
import {
  insertOpenAlert,
  listActiveJobHeartbeats,
  listEnabledPluginBacklogs,
  listOpenAlerts,
  listWorkerSilences,
  resolveAlert,
  type ActiveJobHeartbeat,
  type PluginBacklog,
  type WorkerSilence,
} from '../repositories/operationsAlertRepository.js';
import { enqueueNotificationEvent, type NotificationSubject } from './notificationEvents.js';
import { PollingLoop } from './pollingLoop.js';

// Half the Job heartbeat threshold, so a stale Job is reported within 90 seconds of its last beat.
export const OPERATIONS_MONITOR_INTERVAL_MS = 30_000;
// Shared by every API process on the same schema so only one of them checks at a time.
const MONITOR_LOCK_NAME = 'operations_monitor';

/** A watched subject with what its notifications need besides the stored detail. */
interface WatchedSubject extends MonitoredSubject {
  name: string;
  webPath: string;
  notificationSubject: NotificationSubject;
}

export interface OperationsMonitorTick {
  /** false when another process held the monitor lock and this tick did nothing. */
  acquired: boolean;
  opened: number;
  resolved: number;
}

const OPENED_TITLES: Record<MonitoredSubject['kind'], string> = {
  'job.heartbeat_stale': 'Jobのheartbeatが途絶えました',
  'worker.offline': 'workerが応答しません',
  'plugin.delivery_stalled': 'Pluginへのイベント送信が滞留しています',
};
const JOB_RECOVERED_TITLE = 'Jobのheartbeatが戻りました';

function jobSubject(job: ActiveJobHeartbeat): WatchedSubject {
  return {
    kind: 'job.heartbeat_stale',
    subjectId: job.jobId,
    projectId: job.projectId,
    isAlerting: isJobHeartbeatStale(job.heartbeatAgeSeconds),
    detail: {
      jobId: job.jobId,
      runId: job.runId,
      runName: job.runName,
      workerId: job.workerId,
      heartbeatAt: job.heartbeatAt,
    },
    name: job.runName,
    webPath: `runs/${encodeURIComponent(job.runId)}`,
    notificationSubject: { runKind: job.runKind, experimentId: job.experimentId },
  };
}

function workerSubject(worker: WorkerSilence): WatchedSubject {
  return {
    kind: 'worker.offline',
    subjectId: `${worker.tokenId}:${worker.workerId}`,
    projectId: worker.projectId,
    isAlerting: isWorkerOffline(worker.silentSeconds),
    detail: {
      workerId: worker.workerId,
      hostname: worker.hostname,
      tokenName: worker.tokenName,
      lastSeenAt: worker.lastSeenAt,
      activeJobCount: worker.activeJobCount,
    },
    name: worker.hostname ? `${worker.workerId} (${worker.hostname})` : worker.workerId,
    webPath: 'compute',
    notificationSubject: {},
  };
}

function pluginSubject(backlog: PluginBacklog): WatchedSubject {
  return {
    kind: 'plugin.delivery_stalled',
    subjectId: backlog.pluginId,
    projectId: backlog.projectId,
    isAlerting: isPluginDeliveryStalled(backlog),
    detail: {
      pluginId: backlog.pluginId,
      pluginName: backlog.pluginName,
      undelivered: backlog.pending + backlog.sending,
      oldestPendingAt: backlog.oldestPendingAt,
      maxAttempts: backlog.maxAttempts,
      lastError: backlog.lastError,
    },
    name: backlog.pluginName,
    webPath: 'plugins',
    notificationSubject: {},
  };
}

/**
 * Watches Job heartbeats, worker presence and plugin event delivery every 30 seconds, keeps one
 * operations_alerts row per occurrence, and queues notifications only when an alert opens (and
 * when a stale Job's heartbeat comes back). Each tick is one transaction under an advisory lock,
 * so notifications commit together with the alert rows and API processes do not double-report.
 */
export class OperationsMonitor {
  private readonly loop: PollingLoop;

  constructor(
    private readonly database: Database,
    private readonly options: { webOrigin: string },
  ) {
    this.loop = new PollingLoop({
      intervalMs: OPERATIONS_MONITOR_INTERVAL_MS,
      run: () => this.tick(),
      failureEvent: 'operations_monitor_failed',
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  async tick(): Promise<OperationsMonitorTick> {
    return transaction(this.database, async (connection) => {
      const lock = await connection.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1||':'||current_schema(),0)) AS acquired",
        [MONITOR_LOCK_NAME],
      );
      if (!lock.rows[0]?.acquired) return { acquired: false, opened: 0, resolved: 0 };
      const subjects = await this.readSubjects(connection);
      const plan = planAlertChanges(await listOpenAlerts(connection), subjects);
      let opened = 0;
      for (const subject of plan.open) {
        const alert = await insertOpenAlert(connection, subject);
        if (!alert) continue;
        opened++;
        await this.notify(connection, { alert, subject, type: subject.kind });
      }
      let resolved = 0;
      for (const change of plan.resolve) {
        const alert = await resolveAlert(connection, {
          alertId: change.alert.id,
          resolution: change.resolution,
        });
        if (!alert) continue;
        resolved++;
        // Only Jobs have a recovery event; a Job that ended reports through its Run instead.
        if (alert.kind === 'job.heartbeat_stale' && change.subject)
          await this.notify(connection, {
            alert,
            subject: change.subject,
            type: 'job.heartbeat_recovered',
          });
      }
      return { acquired: true, opened, resolved };
    });
  }

  private async readSubjects(connection: PoolClient): Promise<WatchedSubject[]> {
    const jobs = await listActiveJobHeartbeats(connection);
    const workers = await listWorkerSilences(connection);
    const plugins = await listEnabledPluginBacklogs(connection);
    return [
      ...jobs.map(jobSubject),
      ...workers.filter((worker) => !isWorkerRetired(worker.silentSeconds)).map(workerSubject),
      ...plugins.map(pluginSubject),
    ];
  }

  // The dedupe key carries the alert id, so a subject that fails again later notifies again.
  private async notify(
    connection: PoolClient,
    event: {
      alert: OperationsAlert;
      subject: WatchedSubject;
      type: OperationsAlert['kind'] | 'job.heartbeat_recovered';
    },
  ): Promise<void> {
    const { alert, subject } = event;
    const title =
      event.type === 'job.heartbeat_recovered' ? JOB_RECOVERED_TITLE : OPENED_TITLES[event.type];
    await enqueueNotificationEvent(connection, {
      projectId: alert.projectId,
      type: event.type,
      dedupeKey: `${event.type}:${alert.id}`,
      subject: subject.notificationSubject,
      describe: async () => ({
        title: `${title}: ${subject.name}`,
        run: null,
        details: { alertId: alert.id, ...subject.detail },
        url: `${this.options.webOrigin}/projects/${encodeURIComponent(alert.projectId)}/${subject.webPath}`,
        occurredAt: alert.resolvedAt ?? alert.openedAt,
      }),
    });
  }
}
