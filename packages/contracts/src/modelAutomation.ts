import type { JobStatus, JsonObject, RunStatus } from './index.js';

export interface ModelAutomationRule {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  modelFamilies: string[];
  kind: 'inference' | 'evaluation' | 'processing';
  // 'upstream_run_finished' starts this rule when a Run created by upstreamRuleId finishes.
  trigger: 'model_registered' | 'upstream_run_finished';
  upstreamRuleId: string | null;
  experimentId: string;
  codeVersionId: string;
  targetId: string;
  gpuIds: string[];
  inputDatasetVersionIds: string[];
  parameters: JsonObject;
  tags: Record<string, string>;
  maxAttempts: number;
  createdBy: string;
  createdAt: string;
}

export interface ModelAutomationExecution {
  id: string;
  projectId: string;
  ruleId: string;
  modelVersionId: string;
  runId: string | null;
  jobId: string | null;
  // 'pending' rows are not stored executions: they show the enabled rules that will run once the
  // source Run finishes, and are replaced by a stored execution at that point.
  status: 'pending' | 'queued' | 'failed' | 'skipped';
  // The training Run that produced the version; automation waits for it to finish successfully.
  sourceRunId: string | null;
  runStatus: RunStatus | null;
  jobStatus: JobStatus | null;
  error: string | null;
  // The upstream Run that started this stage; null for the first stage of a pipeline.
  triggerRunId: string | null;
  // The first-stage execution of the same pipeline; equals id for the first stage.
  pipelineRootExecutionId: string | null;
  attempt: number;
  source: 'automatic' | 'manual';
  // The Project admin who applied the rule by hand; null for automatic executions.
  requestedBy: string | null;
  createdAt: string;
}

/** POST /projects/:p/automation-rules/:id/executions: a version, or an upstream Run for chained rules. */
export type CreateAutomationExecution = { modelVersionId: string } | { triggerRunId: string };
