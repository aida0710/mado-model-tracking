// Hyperparameter sweeps. The search space and early-stopping terms follow the W&B sweep config
// (values / value / distribution+min+max+q, metric.goal, early_terminate hyperband).
import type { JobStatus, RunStatus } from './index.js';

export type SweepMethod = 'grid' | 'random' | 'bayes';
export type SweepParameterValue = string | number | boolean;

/**
 * One searched parameter: exactly one of `values` (choose one), `value` (constant) or
 * `distribution` with min/max. log_uniform takes the values themselves as min/max
 * (W&B log_uniform_values); q is only for q_uniform.
 */
export type SweepParameterDefinition =
  | { values: SweepParameterValue[] }
  | { value: SweepParameterValue }
  | {
      distribution: 'uniform' | 'log_uniform' | 'int_uniform' | 'q_uniform';
      min: number;
      max: number;
      q?: number;
    };

export interface SweepObjective {
  /** Run metric name, read in step order. */
  metric: string;
  goal: 'minimize' | 'maximize';
  /** How a trial's metric history becomes one value. last is the value at the largest step. */
  aggregation: 'last' | 'min' | 'max';
}

/** Asynchronous Hyperband (ASHA): rungs at minIter×eta^k steps keep the top 1/eta of trials. */
export interface SweepEarlyStopping {
  type: 'hyperband';
  minIter: number;
  eta: number;
  maxIter?: number;
}

export type SweepStatus = 'running' | 'paused' | 'finished' | 'canceled' | 'failed';

/**
 * Why the sweep has its status. paused: user_requested, task_revision_changed (the Task was
 * edited after the sweep was created), owner_forbidden (the creator is no longer a Project
 * editor), launch_failed (a trial could not be queued). finished: max_trials_reached,
 * search_space_exhausted (grid). canceled: user_requested. failed: suggestion_failed.
 */
export type SweepStatusReason =
  | 'user_requested'
  | 'task_revision_changed'
  | 'owner_forbidden'
  | 'launch_failed'
  | 'max_trials_reached'
  | 'search_space_exhausted'
  | 'suggestion_failed';

export type SweepTrialState =
  | 'queued'
  | 'running'
  | 'finished'
  | 'failed'
  | 'canceled'
  | 'early_stopped';

export interface SweepTrial {
  id: string;
  sweepId: string;
  trialIndex: number;
  parameters: Record<string, SweepParameterValue>;
  runId: string;
  jobId: string;
  state: SweepTrialState;
  /** Aggregated objective; null while running or when the metric was never finite. */
  objectiveValue: number | null;
  objectiveStep: number | null;
  /** For early_stopped: the hyperband rung, e.g. "hyperband_rung_9". */
  stopReason: string | null;
  runStatus: RunStatus;
  jobStatus: JobStatus;
  jobCancelRequested: boolean;
  createdAt: string;
  endedAt: string | null;
}

export type SweepTrialCounts = Record<SweepTrialState, number> & { total: number };

export interface Sweep {
  id: string;
  projectId: string;
  name: string;
  taskId: string;
  taskRevision: number;
  experimentId: string;
  method: SweepMethod;
  searchSpace: Record<string, SweepParameterDefinition>;
  objective: SweepObjective;
  maxTrials: number;
  parallelism: number;
  earlyStopping: SweepEarlyStopping | null;
  seed: number;
  /** null uses the Task's target and GPUs. */
  targetId: string | null;
  gpuIds: string[] | null;
  status: SweepStatus;
  statusReason: SweepStatusReason | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  trialCounts: SweepTrialCounts;
  bestTrial: SweepTrial | null;
}

export interface SweepCreate {
  name: string;
  taskId: string;
  method: SweepMethod;
  searchSpace: Record<string, SweepParameterDefinition>;
  objective: { metric: string; goal: 'minimize' | 'maximize'; aggregation?: 'last' | 'min' | 'max' };
  maxTrials: number;
  parallelism?: number;
  earlyStopping?: SweepEarlyStopping | null;
  /** 0〜4294967295. Omitted: the server picks one and returns it. */
  seed?: number;
  targetId?: string | null;
  gpuIds?: string[] | null;
}

export interface SweepPatch {
  maxTrials?: number;
  parallelism?: number;
}

export interface SweepCancel {
  /** true also requests cancellation of running trials; queued trials are always canceled. */
  cancelRunningTrials: boolean;
}

export interface SweepPage {
  items: Sweep[];
  nextCursor: string | null;
}

export interface SweepTrialPage {
  items: SweepTrial[];
  nextCursor: string | null;
}
