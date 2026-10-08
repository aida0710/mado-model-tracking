import {
  RUN_COMPARISON_MAX_RUNS,
  RUN_COMPARISON_MIN_RUNS,
  type ParameterImportanceRequest,
  type ParameterImportanceResult,
  type RunAnalysisTableRequest,
  type RunAnalysisTableResponse,
  type RunComparison,
  type RunSearchPage,
  type RunSet,
  type Sweep,
  type SweepTrial,
} from '@mmt/contracts';
import { encodeId, invalidResponseError, jsonRequest, projectPath, request } from './http';

// One search page is enough to offer metric names; the API reads every page for the analysis.
const METRIC_KEY_SAMPLE_RUNS = 500;

/** The metric names offered for a Run set, and the sweep objective when the set is a sweep. */
export interface RunAnalysisMetricOptions {
  metricKeys: string[];
  objectiveMetric: string | null;
}

function postAnalysis<T>(projectId: string, path: string, body: unknown, signal?: AbortSignal) {
  return request<T>(`${projectPath(projectId)}/runs/analysis/${path}`, { ...jsonRequest('POST', body), signal });
}

async function comparedMetricKeys(projectId: string, runIds: string[], signal?: AbortSignal): Promise<string[]> {
  const sample = runIds.slice(0, RUN_COMPARISON_MAX_RUNS);
  if (sample.length < RUN_COMPARISON_MIN_RUNS) return [];
  const comparison = await request<RunComparison>(`${projectPath(projectId)}/runs/compare`, {
    ...jsonRequest('POST', { runIds: sample }),
    signal,
  });
  if (!Array.isArray(comparison.rows)) throw invalidResponseError();
  return comparison.rows.filter((row) => row.namespace === 'metrics').map((row) => row.key);
}

async function searchedMetricKeys(
  projectId: string,
  search: Extract<RunSet, { search: unknown }>['search'],
  signal?: AbortSignal,
): Promise<string[]> {
  const page = await request<RunSearchPage>(`${projectPath(projectId)}/runs/search`, {
    ...jsonRequest('POST', { ...search, limit: METRIC_KEY_SAMPLE_RUNS }),
    signal,
  });
  if (!Array.isArray(page.items)) throw invalidResponseError();
  return page.items.flatMap((run) => Object.keys(run.latestMetrics ?? {}));
}

async function sweepMetricOptions(projectId: string, sweepId: string, signal?: AbortSignal) {
  const sweepPath = `${projectPath(projectId)}/sweeps/${encodeId(sweepId)}`;
  const [sweep, trials] = await Promise.all([
    request<Sweep>(sweepPath, { signal }),
    request<{ items: SweepTrial[] }>(`${sweepPath}/trials?limit=${RUN_COMPARISON_MAX_RUNS}`, { signal }),
  ]);
  if (!Array.isArray(trials.items)) throw invalidResponseError();
  const metricKeys = await comparedMetricKeys(
    projectId,
    trials.items.map((trial) => trial.runId),
    signal,
  );
  return { metricKeys: [sweep.objective.metric, ...metricKeys], objectiveMetric: sweep.objective.metric };
}

function sortedUnique(keys: string[]): string[] {
  return [...new Set(keys)].sort();
}

export const runAnalysisApi = {
  table: async (projectId: string, body: RunAnalysisTableRequest, signal?: AbortSignal) => {
    const table = await postAnalysis<RunAnalysisTableResponse>(projectId, 'table', body, signal);
    if (!Array.isArray(table.runs) || !Array.isArray(table.params) || !Array.isArray(table.metrics))
      throw invalidResponseError();
    return table;
  },
  parameterImportance: async (projectId: string, body: ParameterImportanceRequest, signal?: AbortSignal) => {
    const result = await postAnalysis<ParameterImportanceResult>(projectId, 'parameter-importance', body, signal);
    if (!Array.isArray(result.entries) || !Array.isArray(result.excluded)) throw invalidResponseError();
    return result;
  },
  /**
   * The analysis endpoints need metric names up front, so they are sampled from the Runs: the
   * first search page, up to 50 listed Runs (through compare), or the sweep objective and the
   * first trials. A metric only on Runs outside the sample is not offered.
   */
  metricOptions: async (projectId: string, runSet: RunSet, signal?: AbortSignal): Promise<RunAnalysisMetricOptions> => {
    if ('sweepId' in runSet) {
      const options = await sweepMetricOptions(projectId, runSet.sweepId, signal);
      return { ...options, metricKeys: sortedUnique(options.metricKeys) };
    }
    const keys =
      'search' in runSet
        ? await searchedMetricKeys(projectId, runSet.search, signal)
        : await comparedMetricKeys(projectId, runSet.runIds, signal);
    return { metricKeys: sortedUnique(keys), objectiveMetric: null };
  },
};
