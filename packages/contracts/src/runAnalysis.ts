// Analysis of a set of Runs: the params x metrics table behind parallel coordinates and scatter
// plots, and parameter importance. Run list, Compare and Sweep pages share these endpoints.
import type { JsonValue, RunStatus } from './index.js';
import type { RunSearchRequest } from './runSearch.js';
import type { SweepObjective } from './sweeps.js';

/** Bounds browser rendering and the importance computation (docs/api-contract.md). */
export const ANALYSIS_MAX_RUNS = 5000;
export const ANALYSIS_MAX_PARAMS = 100;
export const ANALYSIS_MAX_METRICS = 50;

/**
 * Exactly one source. `search` reads every page of POST /runs/search (active Runs only);
 * `sweepId` reads the trials of one sweep in trial order.
 */
export type RunSet =
  | { runIds: string[] }
  | { search: Omit<RunSearchRequest, 'limit' | 'cursor'> }
  | { sweepId: string };

export interface RunAnalysisTableRequest {
  runSet: RunSet;
  /** Omitted: every param with a value; the ANALYSIS_MAX_PARAMS best covered if there are more. */
  params?: string[];
  /** 1 to ANALYSIS_MAX_METRICS keys, read from the latest metric values. */
  metrics: string[];
}

export interface RunAnalysisRow {
  runId: string;
  name: string;
  experimentId: string;
  status: RunStatus;
  /** Present when the Run is a sweep trial. */
  sweepTrialIndex?: number;
  /** Selected params with a value; recorded (SDK) values win over execution parameters. */
  params: Record<string, JsonValue>;
  /** Selected metrics the Run logged; null when the latest value is NaN or infinite. */
  metrics: Record<string, number | null>;
  /** Only for a sweepId set: the trial's aggregated objective, null until it has one. */
  objective?: number | null;
}

export type RunAnalysisParamKind = 'numeric' | 'categorical';

export interface RunAnalysisParam {
  key: string;
  /** numeric when every value is a number or a numeric string such as '1e-4'. */
  kind: RunAnalysisParamKind;
  /** Only for categorical: the distinct values as strings, in code unit order. */
  values?: string[];
  /** Share of the Runs that have a value. */
  coverage: number;
}

export interface RunAnalysisRange {
  /** null when no Run has a finite value. */
  min: number | null;
  max: number | null;
}

export interface RunAnalysisMetric extends RunAnalysisRange {
  key: string;
}

export interface RunAnalysisObjective extends SweepObjective, RunAnalysisRange {}

export interface RunAnalysisTableResponse {
  runs: RunAnalysisRow[];
  params: RunAnalysisParam[];
  metrics: RunAnalysisMetric[];
  /** Only for a sweepId set. */
  objective?: RunAnalysisObjective;
}

export interface ParameterImportanceRequest {
  runSet: RunSet;
  /** Latest metric value to explain. Required unless runSet is a sweep (then its objective). */
  targetMetric?: string;
  /** Omitted: chosen as for the table. */
  params?: string[];
}

export interface ParameterImportanceEntry {
  param: string;
  kind: RunAnalysisParamKind;
  correlation: number | null;
  /** Impurity decrease, summing to 1 over the params. null when there are too few Runs. */
  importance: number | null;
  /** Out-of-bag permutation importance (drop in R²). null when there are too few Runs. */
  permutationImportance: number | null;
  /** Share of the Runs with a target value that have this param. */
  coverage: number;
}

export type ParameterExclusionReason = 'high_cardinality' | 'no_values';
export type ImportanceUnavailableReason = 'too_few_runs';

export interface ParameterImportanceResult {
  targetMetric: string;
  /** latest_metric: the Run's latest value. sweep_objective: the trial's aggregated objective. */
  targetSource: 'latest_metric' | 'sweep_objective';
  /** Runs with a finite target value, used for the computation. */
  runCount: number;
  /** Runs whose target value is missing or not finite. */
  skippedRunCount: number;
  /** Most important first (by |correlation| while importance is null). */
  entries: ParameterImportanceEntry[];
  excluded: { param: string; reason: ParameterExclusionReason }[];
  importanceUnavailableReason: ImportanceUnavailableReason | null;
  /** Out-of-bag R² of the forest: how far the importance can be trusted. */
  outOfBagR2: number | null;
}
