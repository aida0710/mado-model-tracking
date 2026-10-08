// Evaluation sample tables (jsonl / csv with audio, reference, prediction, score columns):
// parsing, audio path resolution, sorting, and paging. Broken rows are counted, never repaired.

export const EVALUATION_SAMPLES_PAGE_SIZE = 50;
export const EVALUATION_SAMPLE_COLUMNS = ['audio', 'reference', 'prediction', 'score'] as const;
/** Cross-run references: mmt-artifact://runs/<runId>/<path>. */
export const ARTIFACT_REFERENCE_SCHEME = 'mmt-artifact://';

export type EvaluationSampleFormat = 'jsonl' | 'csv';
export type EvaluationSampleErrorReason =
  | 'invalid_json'
  | 'not_object'
  | 'column_count'
  | 'unterminated_quote'
  | 'invalid_text'
  | 'invalid_score';

export interface EvaluationSample {
  /** 1-based line in the file where the row starts. */
  line: number;
  audio: string | null;
  reference: string | null;
  prediction: string | null;
  score: number | null;
}
export interface EvaluationSampleError {
  line: number;
  reason: EvaluationSampleErrorReason;
}
export interface EvaluationSampleTable {
  columns: string[];
  samples: EvaluationSample[];
  errors: EvaluationSampleError[];
}

export function evaluationSampleFormat(path: string, mimeType: string): EvaluationSampleFormat | null {
  const essence = mimeType.split(';')[0]!.trim().toLowerCase();
  const lowerPath = path.toLowerCase();
  if (essence === 'application/x-ndjson' || /\.(jsonl|ndjson)$/.test(lowerPath)) return 'jsonl';
  if (essence === 'text/csv' || lowerPath.endsWith('.csv')) return 'csv';
  return null;
}

/** A table is shown as evaluation samples when it has audio, or both reference and prediction. */
export function isEvaluationSampleTable(columns: readonly string[]): boolean {
  return columns.includes('audio') || (columns.includes('reference') && columns.includes('prediction'));
}

type RowResult = { sample: EvaluationSample } | { reason: EvaluationSampleErrorReason };

function readText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function readScore(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  const score = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof score === 'number' && Number.isFinite(score) ? score : undefined;
}

function toSample(line: number, record: Record<string, unknown>): RowResult {
  const audio = readText(record.audio);
  const reference = readText(record.reference);
  const prediction = readText(record.prediction);
  if (audio === undefined || reference === undefined || prediction === undefined)
    return { reason: 'invalid_text' };
  const score = readScore(record.score);
  if (score === undefined) return { reason: 'invalid_score' };
  return { sample: { line, audio: audio || null, reference, prediction, score } };
}

function collect(rows: Array<{ line: number; result: RowResult }>, columns: string[]): EvaluationSampleTable {
  const table: EvaluationSampleTable = { columns, samples: [], errors: [] };
  for (const { line, result } of rows)
    if ('sample' in result) table.samples.push(result.sample);
    else table.errors.push({ line, reason: result.reason });
  return table;
}

function parseJsonLines(content: string): EvaluationSampleTable {
  const columns = new Set<string>();
  const rows: Array<{ line: number; result: RowResult }> = [];
  content.split(/\r?\n/).forEach((source, index) => {
    if (source.trim() === '') return;
    const line = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      rows.push({ line, result: { reason: 'invalid_json' } });
      return;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      rows.push({ line, result: { reason: 'not_object' } });
      return;
    }
    for (const key of Object.keys(value)) columns.add(key);
    rows.push({ line, result: toSample(line, value as Record<string, unknown>) });
  });
  return collect(rows, [...columns]);
}

interface CsvRecord {
  line: number;
  fields: string[];
  unterminated: boolean;
}

/** RFC 4180 records. Quoted fields may span lines; `line` is where each record starts. */
function readCsvRecords(content: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  const endRecord = () => {
    fields.push(field);
    if (!(fields.length === 1 && fields[0] === '')) records.push({ line: recordLine, fields, unterminated: false });
    fields = [];
    field = '';
    recordLine = line;
  };
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else {
        if (character === '\n') line += 1;
        field += character;
      }
    } else if (character === '"' && field === '') quoted = true;
    else if (character === ',') {
      fields.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      line += 1;
      endRecord();
    } else field += character;
  }
  if (quoted) records.push({ line: recordLine, fields: [...fields, field], unterminated: true });
  else if (field !== '' || fields.length > 0) endRecord();
  return records;
}

function parseCsv(content: string): EvaluationSampleTable {
  const [header, ...records] = readCsvRecords(content);
  if (!header) return { columns: [], samples: [], errors: [] };
  const columns = header.fields.map((name) => name.trim());
  return collect(
    records.map((record) => ({
      line: record.line,
      result: record.unterminated
        ? { reason: 'unterminated_quote' }
        : record.fields.length !== columns.length
          ? { reason: 'column_count' }
          : toSample(record.line, Object.fromEntries(columns.map((name, index) => [name, record.fields[index]]))),
    })),
    columns,
  );
}

export function parseEvaluationSamples(content: string, format: EvaluationSampleFormat): EvaluationSampleTable {
  const withoutBom = content.startsWith('﻿') ? content.slice(1) : content;
  return format === 'jsonl' ? parseJsonLines(withoutBom) : parseCsv(withoutBom);
}

export type EvaluationSampleOrder = 'line' | 'score_asc' | 'score_desc';

/** Rows without a score stay after scored rows in both directions; ties keep file order. */
export function sortEvaluationSamples(
  samples: readonly EvaluationSample[],
  order: EvaluationSampleOrder,
): EvaluationSample[] {
  const direction = order === 'score_desc' ? -1 : 1;
  return [...samples].sort((left, right) => {
    if (order !== 'line') {
      if (left.score === null || right.score === null) {
        if (left.score !== right.score) return left.score === null ? 1 : -1;
      } else if (left.score !== right.score) return (left.score - right.score) * direction;
    }
    return left.line - right.line;
  });
}

export interface Page<T> {
  items: T[];
  /** 0-based page after clamping to the available pages. */
  page: number;
  pageCount: number;
}

export function paginate<T>(items: readonly T[], page: number, pageSize = EVALUATION_SAMPLES_PAGE_SIZE): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(pageCount - 1, Math.max(0, Math.floor(page)));
  return { items: items.slice(current * pageSize, (current + 1) * pageSize), page: current, pageCount };
}

export interface ArtifactReference {
  runId: string;
  path: string;
}
export type ArtifactReferenceError =
  | 'empty'
  | 'absolute_path'
  | 'parent_path'
  | 'unsupported_scheme'
  | 'invalid_run_reference'
  | 'other_project'
  | 'no_table_run';
export type ArtifactReferenceResult =
  | { ok: true; reference: ArtifactReference }
  | { ok: false; error: ArtifactReferenceError };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/** Drops "." and empty segments. Paths are taken literally (no percent-decoding), like Artifact paths. */
function normalizeArtifactPath(path: string): { path: string } | { error: ArtifactReferenceError } {
  if (path.startsWith('/')) return { error: 'absolute_path' };
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) return { error: 'parent_path' };
  if (segments.length === 0) return { error: 'empty' };
  return { path: segments.join('/') };
}

/**
 * Resolves an audio cell to a Run Artifact. A relative path names an Artifact of the Run that holds
 * the table, from that Run's artifact root. mmt-artifact://runs/<runId>/<path> names another Run;
 * the API then only finds Runs of the current Project. The longer form
 * mmt-artifact://projects/<projectId>/runs/<runId>/<path> is accepted only for the current Project.
 */
export function resolveArtifactReference(
  value: string,
  context: { projectId: string; tableRunId: string | null },
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
    if (kind !== 'runs' || !UUID_PATTERN.test(runId ?? '')) return { ok: false, error: 'invalid_run_reference' };
    const normalized = normalizeArtifactPath(rest.join('/'));
    return 'error' in normalized
      ? { ok: false, error: normalized.error }
      : { ok: true, reference: { runId: runId!.toLowerCase(), path: normalized.path } };
  }
  if (URI_SCHEME_PATTERN.test(trimmed)) return { ok: false, error: 'unsupported_scheme' };
  const normalized = normalizeArtifactPath(trimmed);
  if ('error' in normalized) return { ok: false, error: normalized.error };
  if (!context.tableRunId) return { ok: false, error: 'no_table_run' };
  return { ok: true, reference: { runId: context.tableRunId, path: normalized.path } };
}
