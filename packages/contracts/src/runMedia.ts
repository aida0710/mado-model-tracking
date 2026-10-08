import type { ArtifactMediaInfo } from './artifactMediaInfo.js';
import type { JsonObject, JsonValue } from './index.js';

export type RunMediaKind = 'audio' | 'image' | 'video' | 'table';

/**
 * native: registered with POST /runs/:r/media. mlflow: indexed from MLflow's own layout, either
 * log_image(key=, step=) files under images/ or tables listed in the mlflow.loggedArtifacts tag.
 */
export type RunMediaSource = 'native' | 'mlflow';

/** One media file of a Run at a key and step. */
export interface RunMedia {
  id: string;
  runId: string;
  key: string;
  step: number;
  kind: RunMediaKind;
  artifactId: string;
  /** MLflow's compressed .webp of the same image; null when there is none. */
  thumbnailArtifactId: string | null;
  caption: string | null;
  metadata: JsonObject;
  source: RunMediaSource;
  /** The Artifact's path, MIME type and size. */
  path: string;
  mimeType: string;
  size: number;
  /** GET /api/projects/:p/artifacts/:a/content of artifactId. */
  contentUrl: string;
  thumbnailContentUrl: string | null;
  /** Present when the Artifact has media information (audio). */
  mediaInfo?: ArtifactMediaInfo;
  createdAt: string;
}

export interface RunMediaCreateItem {
  /** Client-chosen id; resending the same id and content returns the stored item. */
  id?: string;
  key: string;
  step: number;
  kind: RunMediaKind;
  artifactId: string;
  caption?: string | null;
  metadata?: JsonObject;
}

/** POST /projects/:p/runs/:r/media */
export interface RunMediaCreate {
  items: RunMediaCreateItem[];
}

export interface RunMediaList {
  items: RunMedia[];
}

export interface RunMediaPage {
  items: RunMedia[];
  nextCursor?: string;
}

export interface RunMediaKeySummary {
  key: string;
  kind: RunMediaKind;
  count: number;
  minStep: number;
  maxStep: number;
}

/** POST /projects/:p/media/compare */
export interface MediaCompareRequest {
  runIds: string[];
  key: string;
  kind?: RunMediaKind;
  /** Steps to compare; omitted means each Run's latest step for the key. */
  steps?: number[];
}

export interface MediaCompareRow {
  runId: string;
  /**
   * Aligned with MediaCompareGrid.steps, or a single cell (the Run's latest step) when steps is
   * null. A cell lists the media at that step (normally one) and is null when there is none; a
   * nearby step is never substituted.
   */
  cells: Array<RunMedia[] | null>;
}

export interface MediaCompareGrid {
  key: string;
  /** The requested steps in request order, or null when the request omitted them. */
  steps: number[] | null;
  rows: MediaCompareRow[];
}

export type MediaTableColumnType = 'text' | 'number' | 'audio' | 'image' | 'video' | 'json';

export interface MediaTableColumn {
  name: string;
  type: MediaTableColumnType;
}

/** Why a media cell did not resolve to an Artifact. */
export type MediaTableReferenceError =
  | 'empty'
  | 'absolute_path'
  | 'parent_path'
  | 'unsupported_scheme'
  | 'invalid_run_reference'
  | 'other_project'
  | 'not_found';

/** A cell of an audio/image/video column after resolving its file to an Artifact. */
export interface MediaTableMediaCell {
  type: 'audio' | 'image' | 'video';
  /** The Run and path the cell names; null when the reference is malformed. */
  runId: string | null;
  path: string | null;
  artifactId: string | null;
  /** MLflow's compressed_filepath, resolved the same way. */
  thumbnailArtifactId: string | null;
  error: MediaTableReferenceError | null;
}

/**
 * Cells follow the column type: text is a string, number a number, audio/image/video a
 * MediaTableMediaCell, json any JSON value. A missing value is null in every column type.
 */
export type MediaTableCell = MediaTableMediaCell | JsonValue;

/** GET /projects/:p/runs/:r/media/:mediaId/table */
export interface MediaTablePage {
  columns: MediaTableColumn[];
  rows: MediaTableCell[][];
  totalRows: number;
  offset: number;
}

export const RUN_MEDIA_CREATE_MAX_ITEMS = 1000;
export const RUN_MEDIA_KEY_MAX_LENGTH = 250;
export const RUN_MEDIA_CAPTION_MAX_LENGTH = 1000;
export const RUN_MEDIA_METADATA_MAX_BYTES = 16 * 1024;
export const MEDIA_COMPARE_MAX_RUNS = 20;
export const MEDIA_COMPARE_MAX_STEPS = 50;
export const MEDIA_TABLE_PAGE_MAX_ROWS = 200;
/** Larger table files are downloaded instead of paged by the API. */
export const MEDIA_TABLE_MAX_BYTES = 50 * 1024 * 1024;
/** The MLflow tag that lists log_table files ([{path, type:'table'}]). */
export const MLFLOW_LOGGED_ARTIFACTS_TAG = 'mlflow.loggedArtifacts';
