// Shared reports: Markdown with embedded charts, analyses, Run lists and media, kept as immutable
// revisions. Each embed draws live data with the reader's permissions, or a snapshot stored when
// the revision was saved.
import type { ChartPanelConfig } from './chartPanels.js';
import type { Run } from './index.js';
import type { MetricGroup, MetricSeries } from './metricSeries.js';
import type { MediaCompareGrid, MediaTablePage } from './runMedia.js';
import type {
  ParameterImportanceResult,
  RunAnalysisTableResponse,
  RunSet,
} from './runAnalysis.js';

export const REPORT_TITLE_MAX_LENGTH = 300;
export const REPORT_MARKDOWN_MAX_LENGTH = 100_000;
export const REPORT_MAX_BLOCKS = 200;
/** UTF-8 size of JSON.stringify(blocks). */
export const REPORT_BLOCKS_MAX_BYTES = 1024 * 1024;
export const REPORT_RUN_SET_MAX_RUNS = 200;
export const REPORT_RUN_TABLE_MAX_ROWS = 500;
export const REPORT_MEDIA_MAX_RUNS = 20;
export const REPORT_MEDIA_MAX_STEPS = 50;
export const REPORT_SNAPSHOT_BLOCK_MAX_BYTES = 5 * 1024 * 1024;
export const REPORT_MESSAGE_MAX_LENGTH = 1000;

/** The Runs an embed draws. A saved view must be shared with the Project (`project` visibility). */
export type ReportRunSet = RunSet | { savedViewId: string };

/** live: drawn from the current data. snapshot: drawn from the data stored with the revision. */
export type ReportEmbedMode = 'live' | 'snapshot';

export interface ReportMarkdownBlock {
  id: string;
  type: 'markdown';
  text: string;
}

export interface ReportChartBlock {
  id: string;
  type: 'chart';
  panel: ChartPanelConfig;
  runSet: ReportRunSet;
  mode: ReportEmbedMode;
}

export interface ReportParallelCoordinatesBlock {
  id: string;
  type: 'parallel_coordinates';
  runSet: ReportRunSet;
  /** Param names (without `params.`), one axis each, in order. */
  params: string[];
  /** The metric of the last axis, which also colors the lines. */
  metric: string;
  mode: ReportEmbedMode;
}

export interface ReportParameterImportanceBlock {
  id: string;
  type: 'parameter_importance';
  runSet: ReportRunSet;
  /** Omitted only for a sweep Run set, which then explains the sweep objective. */
  targetMetric?: string;
  mode: ReportEmbedMode;
}

export interface ReportScatterBlock {
  id: string;
  type: 'scatter';
  runSet: ReportRunSet;
  /** Field keys of the analysis table: `params.<name>` or `metrics.<name>`. */
  x: string;
  y: string;
  color?: string;
  mode: ReportEmbedMode;
}

export interface ReportRunTableBlock {
  id: string;
  type: 'run_table';
  runSet: ReportRunSet;
  /** Run list column keys, such as `status`, `metrics.loss` or `params.lr`; the name is always shown. */
  columns: string[];
  /** 1 to REPORT_RUN_TABLE_MAX_ROWS. */
  limit: number;
  mode: ReportEmbedMode;
}

export interface ReportMediaBlock {
  id: string;
  type: 'media';
  /** 1 to REPORT_MEDIA_MAX_RUNS Runs, compared side by side. */
  runIds: string[];
  key: string;
  /** Up to REPORT_MEDIA_MAX_STEPS; empty compares each Run's latest step. */
  steps: number[];
  mode: ReportEmbedMode;
}

export interface ReportMediaTableBlock {
  id: string;
  type: 'media_table';
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
  /** Author and time of the current revision. */
  updatedBy: ReportUser;
  updatedAt: string;
  archivedAt: string | null;
  archivedBy: ReportUser | null;
}

export interface ReportPage {
  items: Report[];
  nextCursor: string | null;
}

export interface ReportRevisionSummary {
  revision: number;
  title: string;
  message: string | null;
  createdBy: ReportUser;
  createdAt: string;
  /** Set when the revision was made by POST /restore. */
  restoredFrom: number | null;
}

/** An immutable revision. */
export interface ReportRevision extends ReportRevisionSummary {
  reportId: string;
  blocks: ReportBlock[];
}

/** GET /reports/:id(?revision=), and the result of create, update and restore. */
export interface ReportDocument {
  report: Report;
  revision: ReportRevision;
}

export interface ReportRevisionList {
  /** Newest first. */
  items: ReportRevisionSummary[];
}

export interface ReportCreate {
  title: string;
  blocks: ReportBlock[];
  message?: string;
}

export interface ReportUpdate {
  /** The revision the edit started from; another current revision is 409 report_revision_conflict. */
  baseRevision: number;
  title: string;
  blocks: ReportBlock[];
  message?: string;
  /** Snapshot blocks to capture again although their content did not change. */
  refreshSnapshotBlockIds?: string[];
}

export interface ReportRestore {
  revision: number;
  /** Same as ReportUpdate.baseRevision; omitted restores over whatever is current. */
  baseRevision?: number;
}

/** A grouped chart stores its groups; any other chart stores each Run's series. */
export type ReportChartSnapshotPlan =
  | { kind: 'series'; series: MetricSeries[] }
  | { kind: 'groups'; groups: MetricGroup[] };

/** Data stored for a snapshot block: what the display component needs, by block type. */
export type ReportSnapshotData =
  | { type: 'chart'; plan: ReportChartSnapshotPlan; runLabels: Record<string, string> }
  | { type: 'parallel_coordinates'; table: RunAnalysisTableResponse }
  | { type: 'parameter_importance'; result: ParameterImportanceResult }
  | { type: 'scatter'; table: RunAnalysisTableResponse }
  | { type: 'run_table'; runs: Run[] }
  | { type: 'media'; grid: MediaCompareGrid; runLabels: Record<string, string> }
  /** The first page of the table; a live block pages through the API instead. */
  | { type: 'media_table'; page: MediaTablePage };

export interface ReportBlockSnapshot {
  blockId: string;
  /** When the data was read; kept while the block content stays the same across revisions. */
  capturedAt: string;
  sizeBytes: number;
  data: ReportSnapshotData;
}

/** GET /reports/:id/snapshots?revision= */
export interface ReportSnapshotList {
  revision: number;
  items: ReportBlockSnapshot[];
}
