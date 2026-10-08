import {
  ANALYSIS_MAX_METRICS,
  REPORT_RUN_SET_MAX_RUNS,
  type ReportBlock,
  type ReportBlockSnapshot,
  type ReportBlockType,
  type ReportChartSnapshotPlan,
  type ReportEmbedBlock,
  type ReportRunSet,
  type RunAnalysisTableRequest,
  type RunSearchRequest,
  type RunSet,
  type SavedViewState,
} from '@mmt/contracts';
import { createPanelConfig, PANEL_HEIGHTS, PANEL_WIDTHS } from './chartPanelLayout';
import { groupChartSeries, runChartSeries } from './metricSeries';
import { metricFieldKey, paramFieldKey } from './runAnalysisFields';
import type { MetricsChartSeries } from '../components/charts/chartProps';

// Block list edits and the requests that draw a live embed. Pure functions: the editor keeps the
// list in state and the block view hands these requests to the API clients.

export type RunSearchConditions = Omit<RunSearchRequest, 'limit' | 'cursor'>;

/** Upper bound of POST /runs/search `filter` (docs/api-contract.md). */
export const RUN_SEARCH_FILTER_MAX_LENGTH = 2000;
/** Page limit of POST /runs/search. */
export const RUN_SEARCH_MAX_LIMIT = 500;

export function isEmbedBlock(block: ReportBlock): block is ReportEmbedBlock {
  return block.type !== 'markdown';
}

/** Inserts the block at `index` (clamped), or at the end. */
export function insertBlock(blocks: readonly ReportBlock[], block: ReportBlock, index = blocks.length): ReportBlock[] {
  const at = Math.max(0, Math.min(index, blocks.length));
  return [...blocks.slice(0, at), block, ...blocks.slice(at)];
}

/** Moves the block by `offset` places; a move past either end leaves the list unchanged. */
export function moveBlock(blocks: readonly ReportBlock[], blockId: string, offset: number): ReportBlock[] {
  const from = blocks.findIndex((block) => block.id === blockId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= blocks.length) return [...blocks];
  const moved = [...blocks];
  const [block] = moved.splice(from, 1);
  moved.splice(to, 0, block!);
  return moved;
}

export function removeBlock(blocks: readonly ReportBlock[], blockId: string): ReportBlock[] {
  return blocks.filter((block) => block.id !== blockId);
}

/** Replaces the block with the same id. */
export function replaceBlock(blocks: readonly ReportBlock[], replacement: ReportBlock): ReportBlock[] {
  return blocks.map((block) => (block.id === replacement.id ? replacement : block));
}

/**
 * A new block with the settings the picker starts from. Embeds start live: a snapshot is chosen
 * on purpose, because it stops following the Runs.
 */
export function createBlock(type: ReportBlockType, id: string, runSet: ReportRunSet = { runIds: [] }): ReportBlock {
  switch (type) {
    case 'markdown':
      return { id, type, text: '' };
    case 'chart':
      return {
        id,
        type,
        // A report draws one chart per block across the page, so the grid cell is fixed.
        panel: { ...createPanelConfig([]), id, layout: { x: 0, y: 0, w: PANEL_WIDTHS.full, h: PANEL_HEIGHTS.normal } },
        runSet,
        mode: 'live',
      };
    case 'parallel_coordinates':
      return { id, type, runSet, params: [], metric: '', mode: 'live' };
    case 'parameter_importance':
      return { id, type, runSet, mode: 'live' };
    case 'scatter':
      return { id, type, runSet, x: '', y: '', mode: 'live' };
    case 'run_table':
      return { id, type, runSet, columns: ['status', 'created'], limit: 50, mode: 'live' };
    case 'media':
      return { id, type, runIds: [], key: '', steps: [], mode: 'live' };
    case 'media_table':
      return { id, type, runId: '', mediaId: '', mode: 'live' };
  }
}

/** The search a saved Run list view stands for: its conditions without columns and charts. */
export function savedViewSearch(state: SavedViewState): RunSearchConditions {
  return {
    ...(state.experimentIds.length ? { experimentIds: state.experimentIds } : {}),
    ...(state.filter.trim() ? { filter: state.filter } : {}),
    ...(state.orderBy.length ? { orderBy: state.orderBy } : {}),
    ...(state.statuses.length ? { statuses: state.statuses } : {}),
    ...(state.kinds.length ? { kinds: state.kinds } : {}),
  };
}

/**
 * The Run set the analysis endpoints take. A saved view becomes its search, so it follows later
 * changes to the view; `savedView` is the view's state, read beforehand.
 */
export function toAnalysisRunSet(runSet: ReportRunSet, savedView?: SavedViewState): RunSet {
  if (!('savedViewId' in runSet)) return runSet;
  if (!savedView) throw new Error('The saved view must be read before its Runs');
  return { search: savedViewSearch(savedView) };
}

const quoteFilterValue = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * Run id filters (`attributes.run_id IN (...)`) that each fit RUN_SEARCH_FILTER_MAX_LENGTH, so a
 * listed Run set can be read through the search, which returns the same summaries as the Run list.
 */
export function runIdFilters(runIds: readonly string[]): string[] {
  const prefix = 'attributes.run_id IN (';
  const filters: string[] = [];
  let values: string[] = [];
  const build = (items: string[]) => `${prefix}${items.join(', ')})`;
  for (const runId of runIds) {
    const value = quoteFilterValue(runId);
    if (values.length && build([...values, value]).length > RUN_SEARCH_FILTER_MAX_LENGTH) {
      filters.push(build(values));
      values = [];
    }
    values.push(value);
  }
  if (values.length) filters.push(build(values));
  return filters;
}

/** Series are requested by Run id; the API takes at most this many Runs per request. */
export const CHART_MAX_RUNS = REPORT_RUN_SET_MAX_RUNS;

/** Params and metrics of the analysis table behind a scatter plot or parallel coordinates. */
export function analysisTableRequest(
  block: Extract<ReportEmbedBlock, { type: 'scatter' | 'parallel_coordinates' }>,
  runSet: RunSet,
): RunAnalysisTableRequest {
  const fields =
    block.type === 'scatter'
      ? [block.x, block.y, ...(block.color ? [block.color] : [])]
      : [...block.params.map(paramFieldKey), metricFieldKey(block.metric)];
  const params = unique(fields.filter((key) => key.startsWith('params.')).map((key) => key.slice('params.'.length)));
  const metrics = unique(fields.filter((key) => key.startsWith('metrics.')).map((key) => key.slice('metrics.'.length)));
  return { runSet, ...(params.length ? { params } : {}), metrics: metrics.slice(0, ANALYSIS_MAX_METRICS) };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Why an embed cannot be saved yet, or null when it is complete. Keys of i18n/reports.ts. */
export type ReportBlockProblem =
  | 'runSetEmpty'
  | 'chartMetricsEmpty'
  | 'parallelMetricEmpty'
  | 'parallelParamsEmpty'
  | 'importanceTargetEmpty'
  | 'scatterAxesEmpty'
  | 'scatterMetricMissing'
  | 'mediaRunsEmpty'
  | 'mediaKeyEmpty'
  | 'mediaTableEmpty';

function isRunSetEmpty(runSet: ReportRunSet): boolean {
  if ('runIds' in runSet) return runSet.runIds.length === 0;
  if ('savedViewId' in runSet) return !runSet.savedViewId;
  if ('sweepId' in runSet) return !runSet.sweepId;
  return false;
}

export function reportBlockProblem(block: ReportBlock): ReportBlockProblem | null {
  if ('runSet' in block && isRunSetEmpty(block.runSet)) return 'runSetEmpty';
  switch (block.type) {
    case 'markdown':
      return null;
    case 'chart':
      return block.panel.metricKeys.length ? null : 'chartMetricsEmpty';
    case 'parallel_coordinates':
      if (!block.metric) return 'parallelMetricEmpty';
      return block.params.length ? null : 'parallelParamsEmpty';
    case 'parameter_importance':
      return block.targetMetric || 'sweepId' in block.runSet ? null : 'importanceTargetEmpty';
    case 'scatter':
      if (!block.x || !block.y) return 'scatterAxesEmpty';
      // The analysis table needs at least one metric.
      return [block.x, block.y, block.color].some((key) => key?.startsWith('metrics.')) ? null : 'scatterMetricMissing';
    case 'run_table':
      return null;
    case 'media':
      if (!block.runIds.length) return 'mediaRunsEmpty';
      return block.key ? null : 'mediaKeyEmpty';
    case 'media_table':
      return block.runId && block.mediaId ? null : 'mediaTableEmpty';
  }
}

export function snapshotsByBlockId(snapshots: readonly ReportBlockSnapshot[]): Map<string, ReportBlockSnapshot> {
  return new Map(snapshots.map((snapshot) => [snapshot.blockId, snapshot]));
}

/**
 * Snapshot blocks to capture again on save: the ones the editor asked to refresh that are still
 * snapshot blocks. A block that changed is captured anyway, so it need not be listed.
 */
export function refreshableSnapshotIds(blocks: readonly ReportBlock[], requested: ReadonlySet<string>): string[] {
  return blocks.filter((block) => isEmbedBlock(block) && block.mode === 'snapshot' && requested.has(block.id)).map((block) => block.id);
}

/**
 * Lines of a chart embed, as the chart grid draws them: with several metric keys each line is a
 * Run (or group) and key pair; with one key the line keeps the Run id so its color matches other
 * charts.
 */
export function reportChartSeries(
  plan: ReportChartSnapshotPlan,
  keys: readonly string[],
  runLabels: Readonly<Record<string, string>>,
): MetricsChartSeries[] {
  return keys.flatMap((key) =>
    (plan.kind === 'series' ? runChartSeries(plan.series, key, runLabels) : groupChartSeries(plan.groups, key)).map(
      (line) => (keys.length > 1 ? { ...line, id: `${line.id}/${key}`, label: `${line.label} · ${key}` } : line),
    ),
  );
}

const twoDigits = (value: number) => String(value).padStart(2, '0');

/** `YYYY-MM-DD HH:mm` in the reader's time zone, for the "fixed at" mark of a snapshot. */
export function formatSnapshotTime(isoTime: string): string {
  const time = new Date(isoTime);
  return `${time.getFullYear()}-${twoDigits(time.getMonth() + 1)}-${twoDigits(time.getDate())} ${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`;
}
