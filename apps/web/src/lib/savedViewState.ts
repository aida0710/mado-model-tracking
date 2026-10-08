import type {
  ChartPanelLayout,
  RunGroupBy,
  RunKind,
  RunStatus,
  SavedViewColumn,
  SavedViewState,
} from '@mmt/contracts';
import { emptyChartPanelLayout, parseChartPanelLayout, setPanelsGroupBy } from './chartPanelLayout';
import { metricRunSort, runSortOrderBy, toRunSearchConditions } from './runFilter';

// Conversion between what the Run list shows and the SavedViewState stored by the API.

/** The only state version this screen understands. A newer API version is refused, not guessed. */
export const SAVED_VIEW_STATE_VERSION = 1;

/** What the Run list shows. Empty strings and null mean the list default. */
export interface RunListDisplay {
  experimentId: string;
  /** The search box text: a Run name substring or a filter expression. */
  searchText: string;
  status: string;
  /** Empty shows every kind. */
  kinds: RunKind[];
  sort: string;
  /** Visible columns after the fixed selection and name columns, in order. */
  columns: SavedViewColumn[];
  /** null shows the default layout derived from the Runs' metrics. */
  chartPanels: ChartPanelLayout | null;
}

export type SavedViewStateParseResult =
  | { ok: true; state: SavedViewState }
  | { ok: false; reason: 'unsupported_version' | 'invalid' };

// A name search has no field of its own in the state, so it is stored as the filter the API
// would run for it. `%` and `_` in the name become wildcards there; names rarely contain them.
const NAME_FILTER_PATTERN = /^attributes\.run_name ILIKE '%((?:[^']|'')*)%'$/;
const quoteFilterString = (value: string) => value.replaceAll("'", "''");

function searchTextToFilter(searchText: string): string {
  const conditions = toRunSearchConditions(searchText);
  if ('filter' in conditions) return conditions.filter;
  if ('name' in conditions) return `attributes.run_name ILIKE '%${quoteFilterString(conditions.name)}%'`;
  return '';
}

function filterToSearchText(filter: string): string {
  const name = NAME_FILTER_PATTERN.exec(filter)?.[1];
  return name === undefined ? filter : name.replaceAll("''", "'");
}

const SORT_ORDER_PATTERN =
  /^metrics\.(?:`((?:[^`]|``)*)`|([\p{L}_][\p{L}\p{N}_]*))\s+(ASC|DESC)$/iu;

/** The list sort for a stored orderBy; null when the list has no matching choice. */
export function runSortFromOrderBy(orderBy: string[]): string | null {
  if (orderBy.length === 0) return 'newest';
  if (orderBy.length > 1) return null;
  const [order] = orderBy as [string];
  for (const sort of ['oldest', 'name']) if (runSortOrderBy(sort)[0] === order) return sort;
  const metric = SORT_ORDER_PATTERN.exec(order.trim());
  if (!metric) return null;
  const key = metric[1] !== undefined ? metric[1].replaceAll('``', '`') : metric[2]!;
  return metricRunSort(key, metric[3]!.toLowerCase() as 'asc' | 'desc');
}

/** The grouping shared by every panel, which the Run list chart toolbar sets for all at once. */
const layoutGroupBy = (layout: ChartPanelLayout): RunGroupBy | undefined => layout.panels[0]?.groupBy;

export function toSavedViewState(display: RunListDisplay): SavedViewState {
  const chartPanels = display.chartPanels ?? emptyChartPanelLayout();
  const groupBy = layoutGroupBy(chartPanels);
  return {
    version: SAVED_VIEW_STATE_VERSION,
    experimentIds: display.experimentId ? [display.experimentId] : [],
    filter: searchTextToFilter(display.searchText),
    orderBy: runSortOrderBy(display.sort),
    statuses: display.status ? [display.status as RunStatus] : [],
    kinds: [...display.kinds],
    columns: display.columns.map(({ key, width }) => (width === undefined ? { key } : { key, width })),
    ...(groupBy ? { groupBy } : {}),
    chartPanels,
  };
}

/**
 * The display for a stored state. The list selects one Experiment and one status, so a view
 * saved through the API with more keeps only the first; unknown orders fall back to newest.
 */
export function toRunListDisplay(state: SavedViewState): RunListDisplay {
  const layout = state.groupBy ? setPanelsGroupBy(state.chartPanels, state.groupBy) : state.chartPanels;
  return {
    experimentId: state.experimentIds[0] ?? '',
    searchText: filterToSearchText(state.filter),
    status: state.statuses[0] ?? '',
    kinds: [...state.kinds],
    sort: runSortFromOrderBy(state.orderBy) ?? 'newest',
    columns: state.columns.map(({ key, width }) => (width === undefined ? { key } : { key, width })),
    // An empty layout is how a view keeps "the default charts" rather than a fixed set.
    chartPanels: layout.panels.length ? layout : null,
  };
}

/** Accepts a state from the API only if this screen can show it as stored. */
export function parseSavedViewState(value: unknown): SavedViewStateParseResult {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'invalid' };
  const state = value as Partial<SavedViewState>;
  if (state.version !== SAVED_VIEW_STATE_VERSION) return { ok: false, reason: 'unsupported_version' };
  const chartPanels = parseChartPanelLayout(state.chartPanels);
  const isStringArray = (items: unknown) =>
    Array.isArray(items) && items.every((item) => typeof item === 'string');
  if (
    !chartPanels ||
    !isStringArray(state.experimentIds) ||
    typeof state.filter !== 'string' ||
    !isStringArray(state.orderBy) ||
    !isStringArray(state.statuses) ||
    !isStringArray(state.kinds) ||
    !Array.isArray(state.columns) ||
    !state.columns.every((column) => typeof column?.key === 'string')
  )
    return { ok: false, reason: 'invalid' };
  return { ok: true, state: { ...(state as SavedViewState), chartPanels } };
}

// Panel order and omitted optional fields do not change what is shown, so they are not changes.
function comparableState(state: SavedViewState): string {
  const layout = parseChartPanelLayout(state.chartPanels) ?? state.chartPanels;
  const panels = [...layout.panels].sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify({
    experimentIds: state.experimentIds,
    filter: state.filter.trim(),
    orderBy: state.orderBy,
    statuses: state.statuses,
    kinds: state.kinds,
    columns: state.columns.map(({ key, width }) => [key, width ?? null]),
    groupBy: state.groupBy ? [state.groupBy.kind, state.groupBy.key ?? null] : null,
    panels,
  });
}

/**
 * Whether the list now shows something other than the saved view ("unsaved changes"). The saved
 * side is compared as the list shows it, so conditions the list cannot show are not a change.
 */
export function hasUnsavedChanges(saved: SavedViewState, current: SavedViewState): boolean {
  return comparableState(toSavedViewState(toRunListDisplay(saved))) !== comparableState(current);
}
