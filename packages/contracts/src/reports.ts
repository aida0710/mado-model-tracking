// Shared reports: Markdown with embedded charts, analysis, Run tables and media, kept as immutable
// revisions. A block in `snapshot` mode is drawn from data fixed when its revision was saved; a
// `live` block is drawn by the Web client with the viewer's own permissions.
import type { ChartPanelConfig } from './chartPanels.js';
import type { Run } from './index.js';
import type { MetricGroup, MetricSeries } from './metricSeries.js';
import type { ParameterImportanceResult, RunAnalysisTableResponse, RunSet } from './runAnalysis.js';
import type { MediaCompareGrid, MediaTablePage } from './runMedia.js';

// Limits published in docs/api-contract.md.
export const REPORT_TITLE_MAX_LENGTH = 300;
export const REPORT_MAX_BLOCKS = 200;
/** The UTF-8 size of `JSON.stringify(blocks)`. */
export const REPORT_BLOCKS_MAX_BYTES = 1024 * 1024;
export const REPORT_MARKDOWN_MAX_LENGTH = 100_000;
export const REPORT_MESSAGE_MAX_LENGTH = 1000;
export const REPORT_RUN_SET_MAX_RUN_IDS = 200;
export const REPORT_RUN_TABLE_MAX_ROWS = 500;
export const REPORT_RUN_TABLE_MAX_COLUMNS = 200;
/** One block's fixed data; the whole revision is bounded by MMT_REPORT_SNAPSHOT_MAX_BYTES. */
export const REPORT_SNAPSHOT_BLOCK_MAX_BYTES = 5 * 1024 * 1024;

/** RunSet of the analysis API, or the search conditions of a Project-wide saved view. */
export type ReportRunSet = RunSet | { savedViewId: string };
export type ReportEmbedMode = 'live' | 'snapshot';

export interface ReportMarkdownBlock {
  type: 'markdown';
  /** Client-chosen, unique within the report and kept across revisions. */
  id: string;
  text: string;
}

export interface ReportChartBlock {
  type: 'chart';
  id: string;
  /** With groupBy the chart shows Run groups (POST /metrics/groups), otherwise one line per Run. */
  panel: ChartPanelConfig;
  runSet: ReportRunSet;
  mode: ReportEmbedMode;
}

export interface ReportParallelCoordinatesBlock {
  type: 'parallel_coordinates';
  id: string;
  runSet: ReportRunSet;
  /** Omitted: chosen as by the analysis table. */
  params?: string[];
  metric: string;
  mode: ReportEmbedMode;
}

export interface ReportParameterImportanceBlock {
  type: 'parameter_importance';
  id: string;
  runSet: ReportRunSet;
  /** Required unless runSet is a sweep (then its objective). */
  targetMetric?: string;
  mode: ReportEmbedMode;
}

/** Axis fields are `params.<key>`, `metrics.<key>` or `objective` (sweep Run sets only). */
export interface ReportScatterBlock {
  type: 'scatter';
  id: string;
  runSet: ReportRunSet;
  x: string;
  y: string;
  color?: string;
  mode: ReportEmbedMode;
}

/** Columns are Run list column keys such as `metrics.loss`, `params.lr` or `tags.team`. */
export interface ReportRunTableBlock {
  type: 'run_table';
  id: string;
  runSet: ReportRunSet;
  columns: string[];
  /** Rows shown, 1 to REPORT_RUN_TABLE_MAX_ROWS, in the order of the Run set. */
  limit: number;
  mode: ReportEmbedMode;
}

export interface ReportMediaBlock {
  type: 'media';
  id: string;
  runIds: string[];
  key: string;
  /** Omitted: each Run's latest step, as POST /media/compare. */
  steps?: number[];
  mode: ReportEmbedMode;
}

export interface ReportMediaTableBlock {
  type: 'media_table';
  id: string;
  runId: string;
  mediaId: string;
  mode: ReportEmbedMode;
}

export type ReportEmbedBlock =
  | ReportChartBlock
  | ReportParallelCoordinatesBlock
  | ReportParameterImportanceBlock
  | ReportScatterBlock
  | ReportRunTableBlock
  | ReportMediaBlock
  | ReportMediaTableBlock;
export type ReportBlock = ReportMarkdownBlock | ReportEmbedBlock;
export type ReportBlockType = ReportBlock['type'];

export interface ReportUser {
  id: string;
  displayName: string;
}

export interface Report {
  id: string;
  projectId: string;
  /** Title of the current revision. */
  title: string;
  currentRevision: number;
  createdBy: ReportUser;
  createdAt: string;
  /** The editor who saved the current revision. */
  updatedBy: ReportUser;
  /** When the last revision was saved or the report was archived or unarchived. */
  updatedAt: string;
  archivedAt: string | null;
  archivedBy: ReportUser | null;
}

export interface ReportRevisionSummary {
  reportId: string;
  revision: number;
  title: string;
  message: string | null;
  /** The editor who saved this revision. */
  createdBy: ReportUser;
  createdAt: string;
  /** Set when the revision was made by POST /restore. */
  restoredFromRevision: number | null;
}

export interface ReportRevision extends ReportRevisionSummary {
  blocks: ReportBlock[];
}

/** GET /reports/:id and the responses of create, update and restore. */
export interface ReportDetail {
  report: Report;
  revision: ReportRevision;
}

export interface ReportPage {
  items: Report[];
  nextCursor: string | null;
}

export interface ReportCreate {
  title: string;
  blocks: ReportBlock[];
  message?: string;
}

export interface ReportUpdate {
  /** The revision the edit started from; another save in between is a 409 conflict. */
  baseRevision: number;
  title: string;
  blocks: ReportBlock[];
  message?: string;
  /** Snapshot blocks to capture again even when unchanged since the previous revision. */
  refreshSnapshotBlockIds?: string[];
}

export interface ReportRestore {
  revision: number;
}

/** A Run of a fixed Run set, enough to label a line or a row. */
export interface ReportSnapshotRun {
  runId: string;
  name: string;
}

export type ReportSnapshotData =
  | {
      type: 'chart';
      runs: ReportSnapshotRun[];
      /** Without panel.groupBy. */
      series?: MetricSeries[];
      /** With panel.groupBy. */
      groups?: MetricGroup[];
    }
  | { type: 'parallel_coordinates'; table: RunAnalysisTableResponse }
  | { type: 'parameter_importance'; importance: ParameterImportanceResult }
  | { type: 'scatter'; table: RunAnalysisTableResponse }
  | { type: 'run_table'; runs: Run[] }
  /** Cells name Artifacts by ID; Artifacts are immutable, so the media stays the same. */
  | { type: 'media'; runs: ReportSnapshotRun[]; grid: MediaCompareGrid }
  /** The first page of the table. */
  | { type: 'media_table'; page: MediaTablePage };

export interface ReportBlockSnapshot {
  blockId: string;
  /** The revision whose save captured the data; earlier than the read revision when carried over. */
  capturedRevision: number;
  capturedAt: string;
  sizeBytes: number;
  data: ReportSnapshotData;
}

/** GET /reports/:id/snapshots?revision= */
export interface ReportSnapshotList {
  revision: number;
  items: ReportBlockSnapshot[];
}
