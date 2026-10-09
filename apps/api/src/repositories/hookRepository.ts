import type {
  Hook,
  HookExecution,
  HookExecutionStatus,
  HookExecutionSubject,
  HookSkipReason,
  HookTrigger,
  JsonObject,
} from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import type { EncryptedSecret } from '../security/secretEncryption.js';
import { INPUT_CHECKPOINT_TAG } from '../domain/serverRunTags.js';

// API responses name the owner and the creator so the page need not show bare user IDs.
const hookSelect = `SELECT h.id,h.project_id,h.name,h.enabled,h.trigger,h.filter,h.template,h.checkpoint_mode,
  h.checkpoint_every,h.concurrency,h.max_starts_per_hour,h.webhook_signature,h.created_by,h.run_as_user_id,
  h.created_at,u.kind AS run_as_kind,u.display_name AS run_as_name,c.display_name AS created_by_name
  FROM hooks h JOIN users u ON u.id=h.run_as_user_id LEFT JOIN users c ON c.id=h.created_by`;

const executionSelect = `SELECT e.id,e.project_id,e.hook_id,e.status,e.subject_kind,e.subject_id,e.reason,e.error,
  e.job_id,e.array_group_id,e.run_id,e.waiting_run_id,e.checkpoint_id,e.requested_by,j.status AS job_status,
  e.created_at,e.updated_at
  FROM hook_executions e LEFT JOIN jobs j ON j.id=e.job_id`;

export async function listHooks(connection: Connection, projectId: string): Promise<Hook[]> {
  return rows(connection, `${hookSelect} WHERE h.project_id=$1 ORDER BY h.created_at DESC,h.id DESC`, [
    projectId,
  ]);
}

export async function findHook(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<Hook | undefined> {
  return first(connection, `${hookSelect} WHERE h.project_id=$1 AND h.id=$2`, [
    reference.projectId,
    reference.id,
  ]);
}

/** Enabled hooks of one trigger, locked against a concurrent toggle while they start. */
export async function lockEnabledHooks(
  connection: Connection,
  reference: { projectId: string; trigger: HookTrigger },
): Promise<Hook[]> {
  return rows(
    connection,
    `${hookSelect} WHERE h.project_id=$1 AND h.trigger=$2 AND h.enabled
    ORDER BY h.created_at,h.id FOR SHARE OF h`,
    [reference.projectId, reference.trigger],
  );
}

export async function lockHook(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<Hook | undefined> {
  return first(connection, `${hookSelect} WHERE h.project_id=$1 AND h.id=$2 FOR SHARE OF h`, [
    reference.projectId,
    reference.id,
  ]);
}

export async function insertHook(
  connection: Connection,
  hook: Omit<Hook, 'enabled' | 'createdAt' | 'runAsKind' | 'runAsName' | 'createdByName'> & {
    webhookSecret: EncryptedSecret | null;
  },
): Promise<void> {
  await connection.query(
    `INSERT INTO hooks(project_id,name,trigger,filter,template,checkpoint_mode,checkpoint_every,concurrency,
      max_starts_per_hour,webhook_signature,webhook_secret_key_id,webhook_secret_payload,created_by,run_as_user_id,id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      hook.projectId,
      hook.name,
      hook.trigger,
      JSON.stringify(hook.filter),
      JSON.stringify(hook.template),
      hook.checkpointMode,
      hook.checkpointEvery,
      hook.concurrency,
      hook.maxStartsPerHour,
      hook.webhookSignature,
      hook.webhookSecret?.keyId ?? null,
      hook.webhookSecret?.payload ?? null,
      hook.createdBy,
      hook.runAsUserId,
      hook.id,
    ],
  );
}

export async function findWebhookSecret(
  connection: Connection,
  hookId: string,
): Promise<{ projectId: string; enabled: boolean; signature: Hook['webhookSignature']; secret: EncryptedSecret } | undefined> {
  const found = await first<{
    projectId: string;
    enabled: boolean;
    webhookSignature: Hook['webhookSignature'];
    webhookSecretKeyId: string | null;
    webhookSecretPayload: Buffer | null;
  }>(
    connection,
    `SELECT project_id,enabled,webhook_signature,webhook_secret_key_id,webhook_secret_payload
    FROM hooks WHERE id=$1 AND trigger='webhook'`,
    [hookId],
  );
  if (!found?.webhookSecretKeyId || !found.webhookSecretPayload) return undefined;
  return {
    projectId: found.projectId,
    enabled: found.enabled,
    signature: found.webhookSignature,
    secret: { keyId: found.webhookSecretKeyId, payload: found.webhookSecretPayload },
  };
}

/** Whether the user a hook runs as may still start Jobs in its Project (an active editor). */
export async function hasHookOwnerAccess(
  connection: Connection,
  hook: Pick<Hook, 'projectId' | 'runAsUserId'>,
): Promise<boolean> {
  const owner = await first<{ hasAccess: boolean }>(
    connection,
    `SELECT u.status='active' AND COALESCE(m.role IN ('editor','admin'),false) AS has_access FROM users u
    LEFT JOIN effective_project_roles m ON m.user_id=u.id AND m.project_id=$2 WHERE u.id=$1`,
    [hook.runAsUserId, hook.projectId],
  );
  return owner?.hasAccess === true;
}

export interface HookExecutionWrite {
  id: string;
  projectId: string;
  hookId: string;
  eventKey: string;
  subjectKind: HookExecutionSubject;
  subjectId: string | null;
  status: HookExecutionStatus;
  reason: HookSkipReason | null;
  payload: JsonObject | null;
  waitingRunId: string | null;
  checkpointId: string | null;
  requestedBy: string | null;
}

/** Records an event once; null when the event already has an execution (a resend). */
export async function insertHookExecution(
  connection: Connection,
  execution: HookExecutionWrite,
): Promise<string | null> {
  const inserted = await first<{ id: string }>(
    connection,
    `INSERT INTO hook_executions(id,project_id,hook_id,event_key,subject_kind,subject_id,status,reason,payload,
      waiting_run_id,checkpoint_id,requested_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (hook_id,event_key) DO NOTHING RETURNING id`,
    [
      execution.id,
      execution.projectId,
      execution.hookId,
      execution.eventKey,
      execution.subjectKind,
      execution.subjectId,
      execution.status,
      execution.reason,
      execution.payload === null ? null : JSON.stringify(execution.payload),
      execution.waitingRunId,
      execution.checkpointId,
      execution.requestedBy,
    ],
  );
  return inserted?.id ?? null;
}

export async function findExecutionIdByEvent(
  connection: Connection,
  event: { hookId: string; eventKey: string },
): Promise<string | null> {
  const found = await first<{ id: string }>(
    connection,
    'SELECT id FROM hook_executions WHERE hook_id=$1 AND event_key=$2',
    [event.hookId, event.eventKey],
  );
  return found?.id ?? null;
}

export async function updateHookExecution(
  connection: Connection,
  update: {
    id: string;
    status: HookExecutionStatus;
    reason?: HookSkipReason | null;
    error?: string | null;
    waitingRunId?: string | null;
    jobId?: string | null;
    arrayGroupId?: string | null;
    runId?: string | null;
  },
): Promise<void> {
  await connection.query(
    `UPDATE hook_executions SET status=$2,reason=$3,error=$4,waiting_run_id=COALESCE($5,waiting_run_id),
      job_id=$6,array_group_id=$7,run_id=$8,updated_at=now()
    WHERE id=$1`,
    [
      update.id,
      update.status,
      update.reason ?? null,
      update.error ?? null,
      update.waitingRunId ?? null,
      update.jobId ?? null,
      update.arrayGroupId ?? null,
      update.runId ?? null,
    ],
  );
}

export async function findHookExecution(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<HookExecution | undefined> {
  return first(connection, `${executionSelect} WHERE e.project_id=$1 AND e.id=$2`, [
    reference.projectId,
    reference.id,
  ]);
}

export async function listHookExecutions(
  connection: Connection,
  query: { projectId: string; hookId?: string; limit: number; cursor?: string },
): Promise<HookExecution[]> {
  return rows(
    connection,
    `${executionSelect} WHERE e.project_id=$1 AND ($2::uuid IS NULL OR e.hook_id=$2)
    AND ($3::uuid IS NULL OR (e.created_at,e.id) < (SELECT created_at,id FROM hook_executions WHERE id=$3))
    ORDER BY e.created_at DESC,e.id DESC LIMIT $4`,
    [query.projectId, query.hookId ?? null, query.cursor ?? null, query.limit],
  );
}

export async function hookExecutionExists(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<boolean> {
  return !!(await first(connection, 'SELECT 1 FROM hook_executions WHERE project_id=$1 AND id=$2', [
    reference.projectId,
    reference.id,
  ]));
}

export interface PendingHookExecution {
  id: string;
  projectId: string;
  hookId: string;
  subjectKind: HookExecutionSubject;
  subjectId: string | null;
  checkpointId: string | null;
  payload: JsonObject | null;
  requestedBy: string | null;
  createdAt: string;
}

const pendingColumns =
  'id,project_id,hook_id,subject_kind,subject_id,checkpoint_id,payload,requested_by,created_at';

/** Pending executions released by the end of this Run, oldest first. */
export async function lockPendingExecutions(
  connection: Connection,
  waitingRunId: string,
): Promise<PendingHookExecution[]> {
  return rows(
    connection,
    `SELECT ${pendingColumns} FROM hook_executions WHERE waiting_run_id=$1 AND status='pending'
    ORDER BY created_at,id FOR UPDATE`,
    [waitingRunId],
  );
}

export async function lockExpiredPendingExecutions(
  connection: Connection,
  expiry: { maxAgeHours: number; limit: number },
): Promise<PendingHookExecution[]> {
  return rows(
    connection,
    `SELECT ${pendingColumns} FROM hook_executions WHERE status='pending'
    AND created_at < now() - make_interval(hours => $1)
    ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [expiry.maxAgeHours, expiry.limit],
  );
}

/** Starts of the hook within the last hour that created Jobs, for max_starts_per_hour. */
export async function countRecentStarts(connection: Connection, hookId: string): Promise<number> {
  const counted = (await first<{ count: number }>(
    connection,
    `SELECT count(*)::int AS count FROM hook_executions
    WHERE hook_id=$1 AND status='queued' AND created_at > now() - interval '1 hour'`,
    [hookId],
  ))!;
  return counted.count;
}

/**
 * The Run of a Job this hook started (or its retry) that has not ended; with a source Run, only
 * Jobs started for that Run's checkpoints, found through the reserved input checkpoint tag that
 * retries copy.
 */
export async function findActiveHookRun(
  connection: Connection,
  scope: { hookId: string; sourceRunId?: string },
): Promise<string | null> {
  const found = await first<{ runId: string }>(
    connection,
    `SELECT j.run_id FROM jobs j JOIN runs r ON r.id=j.run_id
    LEFT JOIN run_checkpoints c ON c.id::text=r.tags->>$3
    WHERE j.hook_id=$1 AND j.status IN ('queued','claimed','running')
    AND ($2::uuid IS NULL OR c.run_id=$2::uuid)
    ORDER BY j.created_at LIMIT 1`,
    [scope.hookId, scope.sourceRunId ?? null, INPUT_CHECKPOINT_TAG],
  );
  return found?.runId ?? null;
}
