import {
  DEFAULT_SERIES_POINTS,
  type ReportEmbedBlock,
  type ReportRunSet,
  type ReportSnapshotData,
  type Run,
  type RunSet,
} from '@mmt/contracts';
import { metricSeriesApi } from './metricSeries';
import { reportsApi } from './reports';
import { runAnalysisApi } from './runAnalysis';
import { runMediaApi } from './runMedia';
import { sweepsApi } from './sweeps';
import { trackingApi } from './tracking';
import {
  analysisTableRequest,
  CHART_MAX_RUNS,
  RUN_SEARCH_MAX_LIMIT,
  runIdFilters,
  toAnalysisRunSet,
} from '../lib/reportBlocks';

// Reads what a live embed draws, with the reader's own permissions, in the same shape as a stored
// snapshot so one view draws both. A media table pages through the API itself and is not read here.

type LiveBlock = Exclude<ReportEmbedBlock, { type: 'media_table' }>;

/** The block's Run set with a saved view replaced by its current search. */
async function resolveRunSet(projectId: string, runSet: ReportRunSet, signal: AbortSignal): Promise<RunSet> {
  if (!('savedViewId' in runSet)) return runSet;
  const view = await reportsApi.savedView(projectId, runSet.savedViewId, signal);
  return toAnalysisRunSet(runSet, view.state);
}

async function runsByIds(projectId: string, runIds: string[], signal: AbortSignal): Promise<Run[]> {
  const pages = await Promise.all(
    runIdFilters(runIds).map((filter) =>
      trackingApi.searchRuns(projectId, { filter, limit: RUN_SEARCH_MAX_LIMIT }, signal),
    ),
  );
  // Keep the order the report lists them in; a deleted or hidden Run is simply missing.
  const byId = new Map(pages.flatMap((page) => page.items).map((run) => [run.id, run]));
  return runIds.flatMap((runId) => byId.get(runId) ?? []);
}

/** Up to `limit` Runs of the set: listed order, search order, or the newest sweep trials. */
async function listRuns(projectId: string, runSet: RunSet, limit: number, signal: AbortSignal): Promise<Run[]> {
  if ('runIds' in runSet) return runsByIds(projectId, runSet.runIds.slice(0, limit), signal);
  if ('search' in runSet) {
    const page = await trackingApi.searchRuns(projectId, { ...runSet.search, limit }, signal);
    return page.items;
  }
  const trials = await sweepsApi.allTrials(projectId, runSet.sweepId, signal);
  const newest = [...trials].sort((left, right) => right.trialIndex - left.trialIndex).slice(0, limit);
  return runsByIds(projectId, newest.map((trial) => trial.runId), signal);
}

const runLabelsOf = (runs: Run[]) => Object.fromEntries(runs.map((run) => [run.id, run.name]));

async function loadChart(
  projectId: string,
  block: Extract<LiveBlock, { type: 'chart' }>,
  runSet: RunSet,
  signal: AbortSignal,
): Promise<ReportSnapshotData> {
  const { panel } = block;
  const common = { keys: panel.metricKeys, xAxis: panel.xAxis, maxPoints: DEFAULT_SERIES_POINTS };
  if (panel.groupBy) {
    const request = { groupBy: panel.groupBy, ...common };
    // Groups take a search directly; listed Runs and sweep trials are grouped by id.
    if ('search' in runSet) {
      const response = await metricSeriesApi.groups(projectId, { search: runSet.search, ...request }, signal);
      return { type: 'chart', plan: { kind: 'groups', groups: response.groups }, runLabels: {} };
    }
    const runIds = (await listRuns(projectId, runSet, CHART_MAX_RUNS, signal)).map((run) => run.id);
    if (!runIds.length) return { type: 'chart', plan: { kind: 'groups', groups: [] }, runLabels: {} };
    const response = await metricSeriesApi.groups(projectId, { runIds, ...request }, signal);
    return { type: 'chart', plan: { kind: 'groups', groups: response.groups }, runLabels: {} };
  }
  const runs = await listRuns(projectId, runSet, CHART_MAX_RUNS, signal);
  if (!runs.length) return { type: 'chart', plan: { kind: 'series', series: [] }, runLabels: {} };
  const response = await metricSeriesApi.series(projectId, { runIds: runs.map((run) => run.id), ...common }, signal);
  return { type: 'chart', plan: { kind: 'series', series: response.series }, runLabels: runLabelsOf(runs) };
}

export async function loadLiveBlockData(
  projectId: string,
  block: LiveBlock,
  signal: AbortSignal,
): Promise<ReportSnapshotData> {
  if (block.type === 'media') {
    const [grid, runs] = await Promise.all([
      runMediaApi.compare(
        projectId,
        { runIds: block.runIds, key: block.key, ...(block.steps.length ? { steps: block.steps } : {}) },
        signal,
      ),
      runsByIds(projectId, block.runIds, signal),
    ]);
    return { type: 'media', grid, runLabels: runLabelsOf(runs) };
  }
  const runSet = await resolveRunSet(projectId, block.runSet, signal);
  switch (block.type) {
    case 'chart':
      return loadChart(projectId, block, runSet, signal);
    case 'parallel_coordinates':
    case 'scatter':
      return { type: block.type, table: await runAnalysisApi.table(projectId, analysisTableRequest(block, runSet), signal) };
    case 'parameter_importance':
      return {
        type: 'parameter_importance',
        result: await runAnalysisApi.parameterImportance(
          projectId,
          { runSet, ...(block.targetMetric ? { targetMetric: block.targetMetric } : {}) },
          signal,
        ),
      };
    case 'run_table':
      return { type: 'run_table', runs: await listRuns(projectId, runSet, block.limit, signal) };
  }
}

// Enough Runs to offer the names a set uses without reading the whole set.
const RUN_SET_SAMPLE_SIZE = 200;

/** The first Runs of the set, from which the embed picker offers metric, param and tag names. */
export async function loadRunSetSample(projectId: string, runSet: ReportRunSet, signal: AbortSignal): Promise<Run[]> {
  return listRuns(projectId, await resolveRunSet(projectId, runSet, signal), RUN_SET_SAMPLE_SIZE, signal);
}
