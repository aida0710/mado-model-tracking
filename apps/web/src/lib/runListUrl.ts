import type { RunKind } from '@mmt/contracts';
import type { RunListDisplay } from './savedViewState';

// URL parameters of the Run list. Conditions live in the URL so a reload or a link keeps them;
// a saved view adds only its id, never its state, which is too long for a link.

export const RUN_LIST_PARAMS = {
  experiment: 'experiment',
  searchText: 'q',
  status: 'status',
  /** Run kinds, comma separated; a saved view may keep more than one. */
  kinds: 'kinds',
  sort: 'sort',
  /** Keeps the chart area open across reloads and shared links. */
  charts: 'charts',
  view: 'view',
} as const;
export const CHARTS_OPEN = '1';
export const DEFAULT_RUN_SORT = 'newest';
const KIND_SEPARATOR = ',';
/** Every Run kind, in the order the list offers them. */
export const RUN_KINDS: readonly RunKind[] = ['training', 'finetuning', 'inference', 'evaluation', 'processing'];
const isRunKind = (value: string): value is RunKind => (RUN_KINDS as readonly string[]).includes(value);

export type RunListConditions = Pick<
  RunListDisplay,
  'experimentId' | 'searchText' | 'status' | 'kinds' | 'sort'
>;

/** The kinds a URL value names; unknown names (an edited link) are dropped, not sent to the API. */
export function parseRunKinds(value: string | null): RunKind[] {
  return [...new Set((value ?? '').split(KIND_SEPARATOR).filter(isRunKind))];
}
export const formatRunKinds = (kinds: readonly RunKind[]) => kinds.join(KIND_SEPARATOR);

export function readRunListConditions(params: URLSearchParams): RunListConditions {
  return {
    experimentId: params.get(RUN_LIST_PARAMS.experiment) ?? '',
    searchText: params.get(RUN_LIST_PARAMS.searchText) ?? '',
    status: params.get(RUN_LIST_PARAMS.status) ?? '',
    kinds: parseRunKinds(params.get(RUN_LIST_PARAMS.kinds)),
    sort: params.get(RUN_LIST_PARAMS.sort) ?? DEFAULT_RUN_SORT,
  };
}

/** The URL of an opened view: its id and the conditions it shows, with charts open if it has any. */
export function runListParamsForView(viewId: string, display: RunListDisplay): URLSearchParams {
  const params = new URLSearchParams({ [RUN_LIST_PARAMS.view]: viewId });
  if (display.experimentId) params.set(RUN_LIST_PARAMS.experiment, display.experimentId);
  if (display.searchText) params.set(RUN_LIST_PARAMS.searchText, display.searchText);
  if (display.status) params.set(RUN_LIST_PARAMS.status, display.status);
  if (display.kinds.length) params.set(RUN_LIST_PARAMS.kinds, formatRunKinds(display.kinds));
  if (display.sort !== DEFAULT_RUN_SORT) params.set(RUN_LIST_PARAMS.sort, display.sort);
  if (display.chartPanels) params.set(RUN_LIST_PARAMS.charts, CHARTS_OPEN);
  return params;
}

/** The shareable link of a view: only `?view=<id>`. */
export function savedViewUrl(origin: string, projectId: string, viewId: string): string {
  const query = new URLSearchParams({ [RUN_LIST_PARAMS.view]: viewId });
  return new URL(`/projects/${encodeURIComponent(projectId)}/experiments?${query}`, origin).href;
}
