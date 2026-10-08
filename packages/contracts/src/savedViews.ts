import type { ChartPanelLayout, RunGroupBy } from './chartPanels.js';
import type { RunKind, RunStatus } from './index.js';

/** `private` is shown only to its owner; `project` is shown to every Project viewer. */
export type SavedViewVisibility = 'private' | 'project';
/** The list page a view restores. Sweeps and artifacts may be added later. */
export type SavedViewPage = 'runs';

/** The UTF-8 size of `JSON.stringify(state)` is bounded so one view stays a small row. */
export const SAVED_VIEW_STATE_MAX_BYTES = 64 * 1024;
export const SAVED_VIEW_NAME_MAX_LENGTH = 200;
export const SAVED_VIEW_MAX_COLUMNS = 200;

export interface SavedViewColumn {
  /** Column identifier of the Run list, such as `metrics.loss` or `params.lr`. */
  key: string;
  /** Width in CSS pixels; absent uses the list default. */
  width?: number;
}

/**
 * Display conditions of the Run list. `filter` and `orderBy` use the syntax of RunSearchRequest
 * and are compiled when the view is saved. An unknown `version` is rejected.
 */
export interface SavedViewState {
  version: 1;
  experimentIds: string[];
  filter: string;
  orderBy: string[];
  statuses: RunStatus[];
  kinds: RunKind[];
  columns: SavedViewColumn[];
  groupBy?: RunGroupBy;
  chartPanels: ChartPanelLayout;
}

export interface SavedView {
  id: string;
  projectId: string;
  ownerUserId: string;
  visibility: SavedViewVisibility;
  page: SavedViewPage;
  name: string;
  state: SavedViewState;
  createdAt: string;
  updatedAt: string;
}

export interface SavedViewCreate {
  visibility: SavedViewVisibility;
  page: SavedViewPage;
  name: string;
  state: SavedViewState;
}

export interface SavedViewPatch {
  name?: string;
  state?: SavedViewState;
  visibility?: SavedViewVisibility;
}
