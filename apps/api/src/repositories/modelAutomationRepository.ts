import type { ModelAutomationExecution } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';

export const automationExecutionSelect = `SELECT e.*,r.status AS run_status,j.status AS job_status
  FROM model_automation_executions e
  LEFT JOIN runs r ON r.id=e.run_id AND r.project_id=e.project_id
  LEFT JOIN jobs j ON j.id=e.job_id AND j.project_id=e.project_id`;

export async function insertAutomationExecution(
  connection: Connection,
  execution: {
    projectId: string;
    ruleId: string;
    modelVersionId: string;
    runId?: string;
    jobId?: string;
    status: ModelAutomationExecution['status'];
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
