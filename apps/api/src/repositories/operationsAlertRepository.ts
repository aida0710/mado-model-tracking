import type {
  OperationsAlert,
  OperationsAlertKind,
  OperationsAlertResolution,
  OperationsAlertState,
  RunKind,
} from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import type { OpenAlertReference, OperationsAlertDetail } from '../domain/operationsAlerts.js';

const ALERT_COLUMNS = 'id,project_id,kind,subject_id,opened_at,resolved_at,resolution,detail';

/** A claimed or running Job with its heartbeat age measured on the database clock. */
export interface ActiveJobHeartbeat {
  jobId: string;
  projectId: string;
  runId: string;
  runName: string;
  runKind: RunKind;
  experimentId: string;
  workerId: string | null;
  heartbeatAt: string | null;
  heartbeatAgeSeconds: number;
}

/** A worker whose token can still authenticate, with its silence measured on the database clock. */
export interface WorkerSilence {
  projectId: string;
  tokenId: string;
  tokenName: string;
  workerId: string;
  hostname: string | null;
  lastSeenAt: string;
  silentSeconds: number;
  activeJobCount: number;
}

/** Undelivered events (pending and sending) of one plugin connection. */
export interface PluginBacklog {
  pluginId: string;
  projectId: string;
  pluginName: string;
  enabled: boolean;
  pending: number;
  sending: number;
  oldestPendingAt: string | null;
  oldestUndeliveredAgeSeconds: number | null;
  maxAttempts: number;
  lastError: string | null;
}

export async function listOpenAlerts(connection: Connection): Promise<OpenAlertReference[]> {
  return rows<OpenAlertReference>(
    connection,
    'SELECT id,kind,subject_id FROM operations_alerts WHERE resolved_at IS NULL',
  );
}

/** Returns undefined when the subject already has an open alert. */
export async function insertOpenAlert(
  connection: Connection,
  alert: {
    projectId: string;
    kind: OperationsAlertKind;
    subjectId: string;
    detail: OperationsAlertDetail;
  },
): Promise<OperationsAlert | undefined> {
  return first<OperationsAlert>(
    connection,
    `INSERT INTO operations_alerts(project_id,kind,subject_id,detail) VALUES($1,$2,$3,$4::jsonb)
    ON CONFLICT (kind,subject_id) WHERE resolved_at IS NULL DO NOTHING RETURNING ${ALERT_COLUMNS}`,
    [alert.projectId, alert.kind, alert.subjectId, JSON.stringify(alert.detail)],
  );
}

/** Returns undefined when the alert was already resolved. */
export async function resolveAlert(
  connection: Connection,
  request: { alertId: string; resolution: OperationsAlertResolution },
): Promise<OperationsAlert | undefined> {
  return first<OperationsAlert>(
    connection,
    `UPDATE operations_alerts SET resolved_at=now(),resolution=$2
    WHERE id=$1 AND resolved_at IS NULL RETURNING ${ALERT_COLUMNS}`,
    [request.alertId, request.resolution],
  );
}

/** Newest first. state 'open' lists unresolved alerts only. */
export async function listProjectAlerts(
  connection: Connection,
  filter: { projectId: string; state: OperationsAlertState; limit: number },
): Promise<OperationsAlert[]> {
  return rows<OperationsAlert>(
    connection,
    `SELECT ${ALERT_COLUMNS} FROM operations_alerts
    WHERE project_id=$1 AND ($2::boolean OR resolved_at IS NULL)
    ORDER BY opened_at DESC,id DESC LIMIT $3`,
    [filter.projectId, filter.state === 'all', filter.limit],
  );
}

// A claimed Job always has heartbeat_at (set on claim); the fallbacks only guard older rows.
export async function listActiveJobHeartbeats(
  connection: Connection,
): Promise<ActiveJobHeartbeat[]> {
  return rows<ActiveJobHeartbeat>(
    connection,
    `SELECT j.id AS job_id,j.project_id,j.run_id,r.name AS run_name,r.kind AS run_kind,
      r.experiment_id,j.worker_id,j.heartbeat_at,
      extract(epoch FROM now()-COALESCE(j.heartbeat_at,j.started_at,j.created_at))::float8
        AS heartbeat_age_seconds
    FROM jobs j JOIN runs r ON r.id=j.run_id
    WHERE j.status IN ('claimed','running')`,
  );
}

// Workers of revoked or expired tokens cannot come back under the same identity, so they are
// not watched.
export async function listWorkerSilences(connection: Connection): Promise<WorkerSilence[]> {
  return rows<WorkerSilence>(
    connection,
    `SELECT w.project_id,w.token_id,t.name AS token_name,w.worker_id,w.hostname,w.last_seen_at,
      extract(epoch FROM now()-w.last_seen_at)::float8 AS silent_seconds,
      (SELECT count(*)::int FROM jobs j WHERE j.worker_token_id=w.token_id AND j.worker_id=w.worker_id
        AND j.status IN ('claimed','running')) AS active_job_count
    FROM workers w JOIN api_tokens t ON t.id=w.token_id
    WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now())`,
  );
}

// The LEFT JOIN keeps plugins with an empty backlog, so their open alert resolves as recovered.
const PLUGIN_BACKLOG_SELECT = `SELECT p.id AS plugin_id,p.project_id,p.name AS plugin_name,p.enabled,
    count(o.id) FILTER (WHERE o.status='pending')::int AS pending,
    count(o.id) FILTER (WHERE o.status='sending')::int AS sending,
    min(o.created_at) FILTER (WHERE o.status='pending') AS oldest_pending_at,
    extract(epoch FROM now()-min(o.created_at))::float8 AS oldest_undelivered_age_seconds,
    COALESCE(max(o.attempts),0)::int AS max_attempts,
    (array_agg(o.last_error ORDER BY o.attempts DESC,o.created_at)
      FILTER (WHERE o.last_error IS NOT NULL))[1] AS last_error
  FROM plugin_connections p LEFT JOIN plugin_outbox o ON o.plugin_id=p.id AND o.status<>'delivered'`;

export async function listEnabledPluginBacklogs(connection: Connection): Promise<PluginBacklog[]> {
  return rows<PluginBacklog>(connection, `${PLUGIN_BACKLOG_SELECT} WHERE p.enabled GROUP BY p.id`);
}

/** undefined when the plugin does not belong to the Project. */
export async function findPluginBacklog(
  connection: Connection,
  reference: { projectId: string; pluginId: string },
): Promise<(PluginBacklog & { lastDeliveredAt: string | null }) | undefined> {
  return first(
    connection,
    `SELECT b.*,(SELECT max(d.delivered_at) FROM plugin_outbox d
        WHERE d.plugin_id=b.plugin_id AND d.status='delivered') AS last_delivered_at
    FROM (${PLUGIN_BACKLOG_SELECT} WHERE p.project_id=$1 AND p.id=$2 GROUP BY p.id) b`,
    [reference.projectId, reference.pluginId],
  );
}
