export type ColumnPriority = 'primary' | 'secondary';

/**
 * Which columns a table shows as cells and which it folds into the row details. Wide layouts show
 * every column; narrow layouts keep the primary ones and leave the rest for when a row is opened.
 */
export function splitColumnsByPriority<C extends { priority: ColumnPriority }>(
  columns: C[],
  narrow: boolean,
): { cellColumns: C[]; detailColumns: C[] } {
  if (!narrow) return { cellColumns: columns, detailColumns: [] };
  return {
    cellColumns: columns.filter((column) => column.priority === 'primary'),
    detailColumns: columns.filter((column) => column.priority === 'secondary'),
  };
}
