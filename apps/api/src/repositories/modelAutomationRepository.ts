import type { ModelAutomationExecution, ModelAutomationRule } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

export type AutomationEventState = 'pending' | 'processed' | 'source_unsuccessful' | 'source_timeout';

export interface PendingAutomationEvent {
  modelVersionId: string;
  projectId: string;
}

const storedExecutionSelect = `SELECT e.id,e.project_id,e.rule_id,e.model_version_id,e.run_id,e.job_id,e.status,e.error,
  e.created_at,mv.source_run_id,r.status AS run_status,j.status AS job_status,e.trigger_run_id,
  e.pipeline_root_execution_id,e.attempt,e.source,e.requested_by
  FROM model_automation_executions e
  JOIN model_versions mv ON mv.id=e.model_version_id
  LEFT JOIN runs r ON r.id=e.run_id AND r.project_id=e.project_id
  LEFT JOIN jobs j ON j.id=e.job_id AND j.project_id=e.project_id
  WHERE e.project_id=$1`;

// A pending event has no stored execution yet, so each enabled registration rule of the version's
// family is shown as the run it will become. The id is derived from (version, rule) to stay stable
// between reads; the stored execution created on completion gets its own id.
const pendingExecutionSelect = `SELECT md5(ev.model_version_id::text||rule.id::text)::uuid AS id,ev.project_id,
  rule.id AS rule_id,ev.model_version_id,NULL::uuid AS run_id,NULL::uuid AS job_id,'pending' AS status,
  NULL AS error,ev.pending_since AS created_at,ev.source_run_id,NULL AS run_status,NULL AS job_status,
  NULL::uuid AS trigger_run_id,md5(ev.model_version_id::text||rule.id::text)::uuid AS pipeline_root_execution_id,
  1 AS attempt,'automatic' AS source,NULL::uuid AS requested_by
  FROM model_automation_events ev
  JOIN model_versions mv ON mv.id=ev.model_version_id
  JOIN models m ON m.id=mv.model_id
  JOIN model_automation_rules rule ON rule.project_id=ev.project_id AND rule.enabled
    AND rule.trigger='model_registered' AND m.family=ANY(rule.model_families)
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

export async function findAutomationExecution(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<ModelAutomationExecution | undefined> {
  return first(connection, `${storedExecutionSelect} AND e.id=$2`, [
    reference.projectId,
    reference.id,
  ]);
}

// Manual applications compare with every attempt of the rule for the version: one still waiting or
// running blocks another, and the next attempt number follows the highest one.
export async function summarizeRuleAttempts(
  connection: Connection,
  reference: { ruleId: string; modelVersionId: string },
): Promise<{ maxAttempt: number; hasActive: boolean }> {
  const summary = await first<{ maxAttempt: number; hasActive: boolean }>(
    connection,
    `SELECT COALESCE(max(e.attempt),0)::int AS max_attempt,
      COALESCE(bool_or(e.status='queued' AND j.status IN ('queued','claimed','running')),false) AS has_active
    FROM model_automation_executions e
    LEFT JOIN jobs j ON j.id=e.job_id AND j.project_id=e.project_id
    WHERE e.rule_id=$1 AND e.model_version_id=$2`,
    [reference.ruleId, reference.modelVersionId],
  );
  return summary ?? { maxAttempt: 0, hasActive: false };
}

export async function hasExecutionForTriggerRun(
  connection: Connection,
  reference: { ruleId: string; triggerRunId: string },
): Promise<boolean> {
  const execution = await first(
    connection,
    'SELECT id FROM model_automation_executions WHERE rule_id=$1 AND trigger_run_id=$2 LIMIT 1',
    [reference.ruleId, reference.triggerRunId],
  );
  return execution !== undefined;
}

// FOR SHARE makes a concurrent enable/disable wait, so the rule set is the one at this moment.
export async function lockRegistrationRules(
  connection: Connection,
  model: { projectId: string; family: string },
): Promise<ModelAutomationRule[]> {
  return rows(
    connection,
    `SELECT * FROM model_automation_rules
    WHERE project_id=$1 AND enabled AND trigger='model_registered' AND $2=ANY(model_families)
    ORDER BY created_at,id FOR SHARE`,
    [model.projectId, model.family],
  );
}

export async function lockDownstreamRules(
  connection: Connection,
  upstream: { projectId: string; ruleId: string; family: string },
): Promise<ModelAutomationRule[]> {
  return rows(
    connection,
    `SELECT * FROM model_automation_rules
    WHERE project_id=$1 AND enabled AND trigger='upstream_run_finished' AND upstream_rule_id=$2
      AND $3=ANY(model_families)
    ORDER BY created_at,id FOR SHARE`,
    [upstream.projectId, upstream.ruleId, upstream.family],
  );
}

export async function lockAutomationRule(
  connection: Connection,
  reference: { projectId: string; id: string; mode: 'share' | 'update' },
): Promise<ModelAutomationRule | undefined> {
  // NO KEY UPDATE serializes manual applications of one rule without blocking execution inserts,
  // which only take KEY SHARE on the rule through their foreign key.
  const lock = reference.mode === 'share' ? 'FOR SHARE' : 'FOR NO KEY UPDATE';
  return first(
    connection,
    `SELECT * FROM model_automation_rules WHERE id=$1 AND project_id=$2 ${lock}`,
    [reference.id, reference.projectId],
  );
}

/**
 * Counts the rules from the first stage down to ruleId (a first-stage rule is 1). Rules are
 * immutable and must exist before a rule can name them, so a cycle cannot be stored; the path
 * check still reports one instead of recursing forever if the data were ever edited by hand.
 */
export async function measureRuleChain(
  connection: Connection,
  reference: { projectId: string; ruleId: string; maxDepth: number },
): Promise<{ depth: number; hasCycle: boolean }> {
  const chain = await first<{ depth: number; hasCycle: boolean }>(
    connection,
    `WITH RECURSIVE chain(id,upstream_rule_id,depth,path,is_cycle) AS (
      SELECT id,upstream_rule_id,1,ARRAY[id],false FROM model_automation_rules
      WHERE id=$1 AND project_id=$2
      UNION ALL
      SELECT r.id,r.upstream_rule_id,c.depth+1,c.path||r.id,r.id=ANY(c.path)
      FROM chain c JOIN model_automation_rules r ON r.id=c.upstream_rule_id AND r.project_id=$2
      WHERE NOT c.is_cycle AND c.depth<=$3
    )
    SELECT max(depth)::int AS depth,bool_or(is_cycle) AS has_cycle FROM chain`,
    [reference.ruleId, reference.projectId, reference.maxDepth],
  );
  return { depth: chain?.depth ?? 0, hasCycle: chain?.hasCycle === true };
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

export interface AutomationExecutionInsert {
  // Callers choosing the id can stamp it on the Run (automation.pipelineRoot) before the row exists.
  id?: string;
  projectId: string;
  ruleId: string;
  modelVersionId: string;
  runId?: string;
  jobId?: string;
  status: Exclude<ModelAutomationExecution['status'], 'pending'>;
  error?: string;
  triggerRunId?: string | null;
  // Omitted for a first stage; the database makes it its own pipeline root.
  pipelineRootExecutionId?: string | null;
  attempt?: number;
  source?: ModelAutomationExecution['source'];
  requestedBy?: string | null;
}

export async function insertAutomationExecution(
  connection: Connection,
  execution: AutomationExecutionInsert,
): Promise<string> {
  const inserted = await first<{ id: string }>(
    connection,
    `INSERT INTO model_automation_executions(id,project_id,rule_id,model_version_id,run_id,job_id,status,error,
      trigger_run_id,pipeline_root_execution_id,attempt,source,requested_by)
    VALUES(COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      execution.id ?? null,
      execution.projectId,
      execution.ruleId,
      execution.modelVersionId,
      execution.runId ?? null,
      execution.jobId ?? null,
      execution.status,
      execution.error ?? null,
      execution.triggerRunId ?? null,
      execution.pipelineRootExecutionId ?? null,
      execution.attempt ?? 1,
      execution.source ?? 'automatic',
      execution.requestedBy ?? null,
    ],
  );
  return inserted!.id;
}

// The creator's role is the higher of the direct membership and SSO group bindings.
export async function hasAutomationCreatorAccess(
  connection: Connection,
  rule: { projectId: string; createdBy: string },
): Promise<boolean> {
  const creator = await first<{ hasAccess: boolean }>(
    connection,
    `SELECT (u.is_admin OR COALESCE(m.role='admin',false)) AS has_access FROM users u
    LEFT JOIN effective_project_roles m ON m.user_id=u.id AND m.project_id=$2 WHERE u.id=$1`,
    [rule.createdBy, rule.projectId],
  );
  return creator?.hasAccess === true;
}
