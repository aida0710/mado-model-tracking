import type {
  MediaTableColumn,
  MediaTableColumnType,
  MediaTableReferenceError,
} from '@mmt/contracts';
import { DomainError } from './errors.js';

/**
 * Media tables are pandas' orient='split' JSON ({columns, data}) as MLflow log_table writes it.
 * A media cell is MLflow's {type:'image', filepath, compressed_filepath?}, the same object with
 * type 'audio' or 'video' (native tables), or a string mmt-artifact:// reference to a file.
 *
 * Paths follow the evaluation sample rule of the Web (apps/web/src/lib/evaluationSamples.ts,
 * resolveArtifactReference): a relative path is an Artifact of the Run holding the table, and
 * mmt-artifact://runs/<runId>/<path> (or .../projects/<projectId>/runs/...) names another Run
 * of the same Project. The rule is restated here because the API cannot import Web code.
 */

export type MediaCellType = 'audio' | 'image' | 'video';

export interface ParsedMediaTable {
  columns: MediaTableColumn[];
  rows: unknown[][];
}

export interface ArtifactReference {
  runId: string;
  path: string;
}

export type ArtifactReferenceResult =
  | { ok: true; reference: ArtifactReference }
  | { ok: false; error: MediaTableReferenceError };

/** What a media cell points at, before the Artifacts are looked up. */
export interface MediaCellReference {
  type: MediaCellType;
  file: ArtifactReferenceResult;
  /** MLflow's compressed_filepath; null when the cell has none. */
  thumbnail: ArtifactReferenceResult | null;
}

export const ARTIFACT_REFERENCE_SCHEME = 'mmt-artifact://';
const MEDIA_CELL_TYPES: readonly MediaCellType[] = ['audio', 'image', 'video'];
// The kind of a string reference comes from its extension; other files stay plain text.
const EXTENSION_CELL_TYPES: Record<string, MediaCellType> = {
  wav: 'audio',
  flac: 'audio',
  mp3: 'audio',
  ogg: 'audio',
  opus: 'audio',
  m4a: 'audio',
  aac: 'audio',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const BYTE_ORDER_MARK = '﻿';

function invalidTable(detail: string): never {
  throw new DomainError(422, `表の形式が不正です: ${detail}`, 'media_table_invalid');
}

/** Parquet is MLflow's other log_table format; only the JSON split format is read. */
export function isParquetTable(table: { path: string; mimeType: string }): boolean {
  const essence = table.mimeType.split(';')[0]!.trim().toLowerCase();
  return table.path.toLowerCase().endsWith('.parquet') || essence === 'application/vnd.apache.parquet';
}

export function parseMediaTable(content: string): ParsedMediaTable {
  const text = content.startsWith(BYTE_ORDER_MARK) ? content.slice(1) : content;
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    invalidTable('JSONとして読めません');
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document))
    invalidTable('{columns, data}のobjectが必要です');
  const { columns, data } = document as { columns?: unknown; data?: unknown };
  if (!Array.isArray(columns) || !columns.every((name) => typeof name === 'string'))
    invalidTable('columnsは文字列の配列が必要です');
  if (!Array.isArray(data)) invalidTable('dataは配列が必要です');
  data.forEach((row, index) => {
    if (!Array.isArray(row) || row.length !== columns.length)
      invalidTable(`${index + 1}行目の列数がcolumnsと違います`);
  });
  const rows = data as unknown[][];
  return {
    columns: (columns as string[]).map((name, index) => ({
      name,
      type: columnType(rows.map((row) => row[index])),
    })),
    rows,
  };
}

/** The media type a single cell holds, or null for any other value. */
export function mediaCellType(cell: unknown): MediaCellType | null {
  if (typeof cell === 'string') {
    if (!cell.startsWith(ARTIFACT_REFERENCE_SCHEME)) return null;
    const extension = /\.([a-z0-9]+)$/i.exec(cell)?.[1]?.toLowerCase();
    return (extension && EXTENSION_CELL_TYPES[extension]) || null;
  }
  if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) return null;
  const { type, filepath } = cell as { type?: unknown; filepath?: unknown };
  return MEDIA_CELL_TYPES.includes(type as MediaCellType) && typeof filepath === 'string'
    ? (type as MediaCellType)
    : null;
}

/** A column is a media column when every value is media of one type; null values are skipped. */
function columnType(values: unknown[]): MediaTableColumnType {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return 'text';
  const firstMediaType = mediaCellType(present[0]);
  if (firstMediaType && present.every((value) => mediaCellType(value) === firstMediaType))
    return firstMediaType;
  if (present.every((value) => typeof value === 'number')) return 'number';
  if (present.every((value) => typeof value === 'string')) return 'text';
  return 'json';
}

/** The file (and MLflow thumbnail) a cell of a media column names, relative to the table's Run. */
export function mediaCellReference(
  cell: unknown,
  context: { projectId: string; tableRunId: string },
): MediaCellReference | null {
  const type = mediaCellType(cell);
  if (!type) return null;
  if (typeof cell === 'string')
    return { type, file: resolveArtifactReference(cell, context), thumbnail: null };
  const { filepath, compressed_filepath: thumbnailPath } = cell as {
    filepath: string;
    compressed_filepath?: unknown;
  };
  return {
    type,
    file: resolveArtifactReference(filepath, context),
    thumbnail:
      typeof thumbnailPath === 'string' ? resolveArtifactReference(thumbnailPath, context) : null,
  };
}

/** Drops "." and empty segments. Paths are taken literally (no percent-decoding), like Artifact paths. */
function normalizeArtifactPath(path: string): { path: string } | { error: MediaTableReferenceError } {
  if (path.startsWith('/')) return { error: 'absolute_path' };
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) return { error: 'parent_path' };
  if (segments.length === 0) return { error: 'empty' };
  return { path: segments.join('/') };
}

/** Same rule as resolveArtifactReference in apps/web/src/lib/evaluationSamples.ts. */
export function resolveArtifactReference(
  value: string,
  context: { projectId: string; tableRunId: string },
): ArtifactReferenceResult {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, error: 'empty' };
  if (trimmed.startsWith(ARTIFACT_REFERENCE_SCHEME)) {
    let segments = trimmed.slice(ARTIFACT_REFERENCE_SCHEME.length).split('/');
    if (segments[0] === 'projects') {
      if (!UUID_PATTERN.test(segments[1] ?? '')) return { ok: false, error: 'invalid_run_reference' };
      if (segments[1]!.toLowerCase() !== context.projectId.toLowerCase())
        return { ok: false, error: 'other_project' };
      segments = segments.slice(2);
    }
    const [kind, runId, ...rest] = segments;
    if (kind !== 'runs' || !UUID_PATTERN.test(runId ?? ''))
      return { ok: false, error: 'invalid_run_reference' };
    const normalized = normalizeArtifactPath(rest.join('/'));
    return 'error' in normalized
      ? { ok: false, error: normalized.error }
      : { ok: true, reference: { runId: runId!.toLowerCase(), path: normalized.path } };
  }
  if (URI_SCHEME_PATTERN.test(trimmed)) return { ok: false, error: 'unsupported_scheme' };
  const normalized = normalizeArtifactPath(trimmed);
  if ('error' in normalized) return { ok: false, error: normalized.error };
  return { ok: true, reference: { runId: context.tableRunId.toLowerCase(), path: normalized.path } };
}
