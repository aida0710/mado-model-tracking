import type { SavedViewColumn } from '@mmt/contracts';

// The movable columns of the Run list: which are shown, in what order and how wide. Selection
// and name stay first and are not part of this list.

/** Shows the first line of the Run description (`mlflow.note.content`) instead of a tag column. */
export const RUN_DESCRIPTION_COLUMN = 'description';
export const RUN_BASE_COLUMNS = ['status', 'created', 'duration', 'user', 'kind'] as const;
// Two of each keep the initial comparison readable before the user picks more columns.
const DEFAULT_METRIC_COLUMNS = 2;
const DEFAULT_PARAMETER_COLUMNS = 2;
/** Narrower than this hides even a short number; wider than this pushes every other column away. */
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 1200;

export const metricColumn = (name: string) => `metrics.${name}`;
export const parameterColumn = (name: string) => `params.${name}`;
export const tagColumn = (name: string) => `tags.${name}`;

export function defaultRunColumns(metricNames: string[], parameterNames: string[]): SavedViewColumn[] {
  return [
    'status',
    'created',
    'duration',
    ...metricNames.slice(0, DEFAULT_METRIC_COLUMNS).map(metricColumn),
    ...parameterNames.slice(0, DEFAULT_PARAMETER_COLUMNS).map(parameterColumn),
    'user',
  ].map((key) => ({ key }));
}

/** Hides a shown column, or shows a hidden one at the end. */
export function toggleColumn(columns: SavedViewColumn[], key: string): SavedViewColumn[] {
  return columns.some((column) => column.key === key)
    ? columns.filter((column) => column.key !== key)
    : [...columns, { key }];
}

/** Moves `key` to where `targetKey` is, shifting the columns between them. */
export function moveColumn(
  columns: SavedViewColumn[],
  key: string,
  targetKey: string,
): SavedViewColumn[] {
  const from = columns.findIndex((column) => column.key === key);
  const to = columns.findIndex((column) => column.key === targetKey);
  if (from < 0 || to < 0 || from === to) return columns;
  const next = [...columns];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Moves `key` one place left (-1) or right (1); the ends stay where they are. */
export function shiftColumn(
  columns: SavedViewColumn[],
  key: string,
  offset: -1 | 1,
): SavedViewColumn[] {
  const index = columns.findIndex((column) => column.key === key);
  const target = columns[index + offset];
  return index < 0 || !target ? columns : moveColumn(columns, key, target.key);
}

export const clampColumnWidth = (width: number) =>
  Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));

export function resizeColumn(
  columns: SavedViewColumn[],
  key: string,
  width: number,
): SavedViewColumn[] {
  return columns.map((column) =>
    column.key === key ? { ...column, width: clampColumnWidth(width) } : column,
  );
}

/** The first non-empty line of a Markdown description, without heading or list markers. */
export function descriptionSummary(description: string): string {
  const line = description.split('\n').find((candidate) => candidate.trim()) ?? '';
  return line.trim().replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '');
}
