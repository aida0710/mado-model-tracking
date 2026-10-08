// Cells of a Run media table (MLflow log_table's split format plus audio and video columns):
// what each cell shows, and which media cells the API could not resolve.
import type { MediaTableColumn, MediaTableColumnType, MediaTableReferenceError } from '@mmt/contracts';
import { formatValue } from './format';

export const MEDIA_TABLE_PAGE_SIZE = 50;

export type MediaCellType = 'audio' | 'image' | 'video';
const MEDIA_COLUMN_TYPES: readonly MediaTableColumnType[] = ['audio', 'image', 'video'];

/**
 * 'unresolved' is a media cell that is not the API's resolved form (for example an MLflow
 * {type, filepath} cell or a bare mmt-artifact:// string): it names no Artifact, so the Web does
 * not guess one from the path.
 */
export type MediaTableCellFailure = MediaTableReferenceError | 'unresolved';

export interface ResolvedMediaCell {
  type: MediaCellType;
  runId: string | null;
  path: string;
  artifactId: string;
  thumbnailArtifactId: string | null;
}

export type MediaTableCellView =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'json'; text: string }
  | { kind: 'media'; media: ResolvedMediaCell }
  | { kind: 'error'; reason: MediaTableCellFailure; path: string };

export function isMediaColumnType(type: MediaTableColumnType): type is MediaCellType {
  return MEDIA_COLUMN_TYPES.includes(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REFERENCE_ERRORS: readonly MediaTableReferenceError[] = [
  'empty',
  'absolute_path',
  'parent_path',
  'unsupported_scheme',
  'invalid_run_reference',
  'other_project',
  'not_found',
];

function writtenPath(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    for (const field of ['path', 'filepath'] as const) if (typeof value[field] === 'string') return value[field];
    if (value.path === null) return '';
  }
  return formatValue(value);
}

function describeMediaCell(columnType: MediaCellType, value: unknown): MediaTableCellView {
  if (value === null || value === undefined) return { kind: 'empty' };
  const path = writtenPath(value);
  if (!isRecord(value)) return { kind: 'error', reason: 'unresolved', path };
  if (typeof value.error === 'string') {
    const reason = REFERENCE_ERRORS.includes(value.error as MediaTableReferenceError)
      ? (value.error as MediaTableReferenceError)
      : 'unresolved';
    return { kind: 'error', reason, path };
  }
  if (typeof value.artifactId !== 'string' || value.artifactId === '') return { kind: 'error', reason: 'unresolved', path };
  // A cell whose own type disagrees with its column (an image in an audio column) is shown as what it is.
  const type = MEDIA_COLUMN_TYPES.includes(value.type as MediaTableColumnType) ? (value.type as MediaCellType) : columnType;
  return {
    kind: 'media',
    media: {
      type,
      runId: typeof value.runId === 'string' ? value.runId : null,
      path,
      artifactId: value.artifactId,
      thumbnailArtifactId: typeof value.thumbnailArtifactId === 'string' ? value.thumbnailArtifactId : null,
    },
  };
}

/** How one cell is shown, decided by its column's type and then by the value itself. */
export function describeTableCell(column: MediaTableColumn, value: unknown): MediaTableCellView {
  if (isMediaColumnType(column.type)) return describeMediaCell(column.type, value);
  if (value === null || value === undefined) return { kind: 'empty' };
  if (column.type === 'number' && typeof value === 'number') return { kind: 'number', text: formatValue(value) };
  if (typeof value === 'string') return { kind: 'text', text: value };
  if (typeof value === 'number' || typeof value === 'boolean') return { kind: 'text', text: String(value) };
  return { kind: 'json', text: JSON.stringify(value) };
}

/** Media cells on the page that could not be shown, counted so the table can say how many. */
export function countErrorCells(columns: readonly MediaTableColumn[], rows: readonly unknown[][]): number {
  let errors = 0;
  for (const row of rows)
    columns.forEach((column, index) => {
      if (describeTableCell(column, row[index]).kind === 'error') errors += 1;
    });
  return errors;
}

/** Pages of an offset-paged table; an empty table still has one (empty) page. */
export function tablePageCount(totalRows: number, pageSize = MEDIA_TABLE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(totalRows / pageSize));
}
