import type { JsonObject, Model, ModelVersion, RunKind, RunStatus } from './index.js';

/** GET /projects/:p/model-versions/:id: one version with its Model and the aliases on it. */
export interface ModelVersionDetail {
  version: ModelVersion;
  model: Model;
  // Aliases of the Model that point at this version, sorted by name.
  aliases: string[];
}

/**
 * A Run seen from the version page or from its upstream Run. automatic tells whether an automation
 * execution created it (a manual Job retry of such a Run counts); Run tags are never consulted.
 */
export interface AutomatedRunSummary {
  id: string;
  name: string;
  kind: RunKind;
  status: RunStatus;
  modelVersionId: string | null;
  codeVersionId: string | null;
  parentRunId: string | null;
  latestMetrics: Record<string, number>;
  parameters: JsonObject;
  // The fixed evaluation data (ground truth): inputDatasetVersionIds minus the upstream outputs.
  referenceDatasetVersionIds: string[];
  // Inputs that an upstream Run produced, such as inference outputs fed to an evaluation.
  upstreamDatasetVersionIds: string[];
  automatic: boolean;
  ruleId: string | null;
  executionId: string | null;
  // The first-stage execution of the automation pipeline; null for Runs a person created.
  pipelineRootExecutionId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** GET /projects/:p/model-versions/:id/evaluations?kind=&limit=&cursor= */
export interface ModelVersionEvaluationSummary {
  modelVersionId: string;
  items: AutomatedRunSummary[];
  nextCursor: string | null;
}

/** GET /projects/:p/runs/:r/downstream?limit=&cursor=: Runs whose parentRunId is the Run. */
export interface RunDownstreamPage {
  runId: string;
  items: AutomatedRunSummary[];
  nextCursor: string | null;
}

// Run kinds the version page treats as results of a version (not producers of one).
export const MODEL_VERSION_RESULT_RUN_KINDS = ['inference', 'evaluation', 'processing'] as const;
export type ModelVersionResultRunKind = (typeof MODEL_VERSION_RESULT_RUN_KINDS)[number];
