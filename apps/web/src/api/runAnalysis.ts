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
import { orderAnalysisMetricKeys } from '../lib/runAnalysisFields';
import { SWEEP_ID_TAG } from '../lib/sweepRunTags';

// One search page is enough to offer metric names; the API reads every page for the analysis.
const METRIC_KEY_SAMPLE_RUNS = 500;

/** The metric names offered for a Run set, and the sweep objective when the set is a sweep. */
export interface RunAnalysisMetricOptions {
  /** Result metrics by name first, then system metrics. */
  metricKeys: string[];
  objectiveMetric: string | null;
  /**
   * The metric a set of listed Runs opens with: the objective of the sweep they all are trials
   * of, since their latest value of it is what the sweep compared. Null otherwise.
   */
  preferredMetric?: string | null;
}

function postAnalysis<T>(projectId: string, path: string, body: unknown, signal?: AbortSignal) {
  return request<T>(`${projectPath(projectId)}/runs/analysis/${path}`, { ...jsonRequest('POST', body), signal });
}

interface ComparedKeys {
  metricKeys: string[];
  /** The sweep every compared Run is a trial of, if they share one. */
  sweepId: string | null;
}

async function comparedKeys(projectId: string, runIds: string[], signal?: AbortSignal): Promise<ComparedKeys> {
  const sample = runIds.slice(0, RUN_COMPARISON_MAX_RUNS);
  if (sample.length < RUN_COMPARISON_MIN_RUNS) return { metricKeys: [], sweepId: null };
  const comparison = await request<RunComparison>(`${projectPath(projectId)}/runs/compare`, {
    ...jsonRequest('POST', { runIds: sample }),
    signal,
  });
  if (!Array.isArray(comparison.rows)) throw invalidResponseError();
  const sweepIds = new Set(
    comparison.rows.find((row) => row.namespace === 'tags' && row.key === SWEEP_ID_TAG)?.values ?? [null],
  );
  const [sharedSweepId] = sweepIds;
  return {
    metricKeys: comparison.rows.filter((row) => row.namespace === 'metrics').map((row) => row.key),
    sweepId: sweepIds.size === 1 && typeof sharedSweepId === 'string' ? sharedSweepId : null,
  };
}

const sweepPath = (projectId: string, sweepId: string) =>
  `${projectPath(projectId)}/sweeps/${encodeId(sweepId)}`;

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
  const path = sweepPath(projectId, sweepId);
  const [sweep, trials] = await Promise.all([
    request<Sweep>(path, { signal }),
    request<{ items: SweepTrial[] }>(`${path}/trials?limit=${RUN_COMPARISON_MAX_RUNS}`, { signal }),
  ]);
  if (!Array.isArray(trials.items)) throw invalidResponseError();
  const { metricKeys } = await comparedKeys(
    projectId,
    trials.items.map((trial) => trial.runId),
    signal,
  );
  return { metricKeys: [sweep.objective.metric, ...metricKeys], objectiveMetric: sweep.objective.metric };
}

async function listedRunMetricOptions(
  projectId: string,
  runIds: string[],
  signal?: AbortSignal,
): Promise<RunAnalysisMetricOptions> {
  const compared = await comparedKeys(projectId, runIds, signal);
  const metricKeys = orderAnalysisMetricKeys(compared.metricKeys);
  if (!compared.sweepId) return { metricKeys, objectiveMetric: null };
  // Only the default choice depends on the sweep; a sweep that cannot be read (deleted) must not
  // keep the Runs from being analysed.
  const sweep = await request<Sweep>(sweepPath(projectId, compared.sweepId), { signal }).catch(
    (error: unknown) => {
      if (signal?.aborted) throw error;
      return null;
    },
  );
  return { metricKeys, objectiveMetric: null, preferredMetric: sweep?.objective.metric ?? null };
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
      return { ...options, metricKeys: orderAnalysisMetricKeys(options.metricKeys) };
    }
    if ('runIds' in runSet) return listedRunMetricOptions(projectId, runSet.runIds, signal);
    const keys = await searchedMetricKeys(projectId, runSet.search, signal);
    return { metricKeys: orderAnalysisMetricKeys(keys), objectiveMetric: null };
  },
};
