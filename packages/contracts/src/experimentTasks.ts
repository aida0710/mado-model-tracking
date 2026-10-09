import type { CodeSource, Job, JsonObject, Run, RunKind } from './index.js';
import type { ExecutionRuntime } from './executionRuntime.js';

export type ExecutionMode = 'run' | 'test';

/** Immutable instructions captured at Run creation, including repository edits. */
export interface ExecutionSnapshot {
  codeVersionId: string;
  version: string;
  mode: ExecutionMode;
  source: CodeSource | null;
  runtime: ExecutionRuntime;
  entrypoint: string[];
  requirements: string[];
  environment: Record<string, string>;
}

/** Editable launch defaults; previous Runs retain their revision and fixed code. */
export interface ExperimentTask {
  id: string;
  projectId: string;
  experimentId: string;
  name: string;
  description: string;
  kind: RunKind;
  codeVersionId: string;
  modelVersionId: string | null;
  inputDatasetVersionIds: string[];
  parameters: JsonObject;
  tags: Record<string, string>;
  targetId: string | null;
  gpuIds: string[];
  /** GPUs a site Job asks for (sites take a count; ssh/local targets take gpuIds). */
  gpuCount: number;
  /** Time limit a site Job asks for; null leaves it to the site's job shell. */
  walltimeSeconds: number | null;
  /** Registration target for a successful training/finetuning Run; null means none. */
  outputModel?: TaskOutputModel | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Exactly one of modelId and createModel is set. */
export interface TaskOutputModel {
  modelId: string | null;
  createModel: { name: string; family: string } | null;
  artifactPath: string;
  versionTemplate?: string;
  defaultCodeVersionId?: string | null;
  metadata?: JsonObject;
}

/** Result of the Task-side registration after the Run ends. */
export interface RunOutputRegistration {
  status: 'registered' | 'failed' | 'skipped';
  modelVersionId: string | null;
  error: string | null;
  reason: 'already_registered_by_run' | null;
}

export interface TaskExecution {
  run: Run;
  job: Job;
}

/** A bounded history page; full execution snapshots are read from Run details. */
export interface TaskRunPage {
  items: Run[];
  nextCursor: string | null;
}

/** Text files from an exact commit; skipped paths remain in the repository. */
export interface RepositoryFiles {
  commit: string;
  files: Record<string, string>;
  omittedPaths: string[];
}
