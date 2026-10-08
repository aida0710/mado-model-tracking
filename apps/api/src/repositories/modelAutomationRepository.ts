import type { ModelAutomationExecution } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

export type AutomationEventState = 'pending' | 'processed' | 'source_unsuccessful' | 'source_timeout';

export interface PendingAutomationEvent {
  modelVersionId: string;
  projectId: string;
}

const storedExecutionSelect = `SELECT e.id,e.project_id,e.rule_id,e.model_version_id,e.run_id,e.job_id,e.status,e.error,
  e.created_at,mv.source_run_id,r.status AS run_status,j.status AS job_status
  FROM model_automation_executions e
  JOIN model_versions mv ON mv.id=e.model_version_id
  LEFT JOIN runs r ON r.id=e.run_id AND r.project_id=e.project_id
  LEFT JOIN jobs j ON j.id=e.job_id AND j.project_id=e.project_id
  WHERE e.project_id=$1`;

// A pending event has no stored execution yet, so each enabled rule of the version's family is
// shown as the run it will become. The id is derived from (version, rule) to stay stable between
// reads; the stored execution created on completion gets its own id.
const pendingExecutionSelect = `SELECT md5(ev.model_version_id::text||rule.id::text)::uuid AS id,ev.project_id,
  rule.id AS rule_id,ev.model_version_id,NULL::uuid AS run_id,NULL::uuid AS job_id,'pending' AS status,
  NULL AS error,ev.pending_since AS created_at,ev.source_run_id,NULL AS run_status,NULL AS job_status
  FROM model_automation_events ev
  JOIN model_versions mv ON mv.id=ev.model_version_id
  JOIN models m ON m.id=mv.model_id
  JOIN model_automation_rules rule ON rule.project_id=ev.project_id AND rule.enabled
    AND m.family=ANY(rule.model_families)
  WHERE ev.project_id=$1 AND ev.state='pending'`;

export async function listAutomationExecutions(
  connection: Connection,
  page: { projectId: string; limit: number },
): Promise<ModelAutomationExecution[]> {
  return rows(
    connection,
    `${storedExecutionSelect} UNION ALL ${pendingExecutionSelect} ORDER BY created_at DESC,id DESC LIMIT $2`,
    [page.projectId, page.limit],
  );
}

export async function insertAutomationEvent(
  connection: Connection,
  event: { modelVersionId: string; projectId: string; sourceRunId: string | null; isPending: boolean },
): Promise<boolean> {
  // ON CONFLICT waits for concurrent registration processing; a rollback leaves the event retryable.
  const inserted = await first(
    connection,
    `INSERT INTO model_automation_events(model_version_id,project_id,source_run_id,state,pending_since)
    VALUES($1,$2,$3,$4,CASE WHEN $4='pending' THEN now() END) ON CONFLICT DO NOTHING RETURNING model_version_id`,
    [
      event.modelVersionId,
      event.projectId,
      event.sourceRunId,
      event.isPending ? 'pending' : 'processed',
    ],
  );
  return inserted !== undefined;
}

// Terminal handlers and the sweeper both lock pending events, so each one is resolved once.
export async function lockPendingAutomationEvents(
  connection: Connection,
  sourceRunId: string,
): Promise<PendingAutomationEvent[]> {
  return rows(
    connection,
    `SELECT model_version_id,project_id FROM model_automation_events
    WHERE source_run_id=$1 AND state='pending' ORDER BY pending_since,model_version_id FOR UPDATE`,
    [sourceRunId],
  );
}

// SKIP LOCKED leaves events that a terminal handler is resolving right now to that handler.
export async function lockExpiredAutomationEvents(
  connection: Connection,
  expiry: { maxAgeHours: number; limit: number },
): Promise<PendingAutomationEvent[]> {
  return rows(
    connection,
    `SELECT ev.model_version_id,ev.project_id FROM model_automation_events ev
    LEFT JOIN runs r ON r.id=ev.source_run_id AND r.project_id=ev.project_id
    WHERE ev.state='pending'
      AND (ev.pending_since<now()-make_interval(hours=>$1) OR r.lifecycle_stage='deleted')
    ORDER BY ev.pending_since,ev.model_version_id LIMIT $2 FOR UPDATE OF ev SKIP LOCKED`,
    [expiry.maxAgeHours, expiry.limit],
  );
}

export async function resolveAutomationEvent(
  connection: Connection,
  resolution: { modelVersionId: string; state: Exclude<AutomationEventState, 'pending'> },
): Promise<void> {
  await connection.query(
    `UPDATE model_automation_events SET state=$2 WHERE model_version_id=$1 AND state='pending'`,
    [resolution.modelVersionId, resolution.state],
  );
}

export async function insertAutomationExecution(
  connection: Connection,
  execution: {
    projectId: string;
    ruleId: string;
    modelVersionId: string;
    runId?: string;
    jobId?: string;
    status: Exclude<ModelAutomationExecution['status'], 'pending'>;
    error?: string;
  },
): Promise<void> {
  await connection.query(
    `INSERT INTO model_automation_executions(project_id,rule_id,model_version_id,run_id,job_id,status,error)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      execution.projectId,
      execution.ruleId,
      execution.modelVersionId,
      execution.runId ?? null,
      execution.jobId ?? null,
      execution.status,
      execution.error ?? null,
    ],
  );
}

export async function hasAutomationCreatorAccess(
  connection: Connection,
  rule: { projectId: string; createdBy: string },
): Promise<boolean> {
  const creator = await first<{ hasAccess: boolean }>(
    connection,
    `SELECT (u.is_admin OR COALESCE(m.role='admin',false)) AS has_access FROM users u
    LEFT JOIN project_members m ON m.user_id=u.id AND m.project_id=$2 WHERE u.id=$1`,
    [rule.createdBy, rule.projectId],
  );
  return creator?.hasAccess === true;
}
