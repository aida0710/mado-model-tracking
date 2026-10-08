/**
 * How a table decides which columns stay in the row. Primary columns are always shown; secondary
 * columns move into the row's details when the window is narrow.
 */
export type ColumnPriority = 'primary' | 'secondary';

export function splitColumnsByPriority<Column extends { priority: ColumnPriority }>(
  columns: Column[],
  isNarrow: boolean,
): { shown: Column[]; folded: Column[] } {
  if (!isNarrow) return { shown: columns, folded: [] };
  return {
    shown: columns.filter((column) => column.priority === 'primary'),
    folded: columns.filter((column) => column.priority === 'secondary'),
  };
}
