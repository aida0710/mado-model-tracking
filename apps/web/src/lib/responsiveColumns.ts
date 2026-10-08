/** How important a table column is: primary columns stay visible on narrow screens. */
export type ColumnPriority = 'primary' | 'secondary';

/**
 * Splits columns into those shown in the row and those shown only when a row is opened. Wide
 * screens show every column; narrow screens keep the primary ones in the row. A table with no
 * primary column keeps its first column so a narrow row is never empty.
 */
export function splitColumnsByPriority<T extends { priority: ColumnPriority }>(
  columns: readonly T[],
  isNarrow: boolean,
) {
  if (!isNarrow) return { rowColumns: [...columns], detailColumns: [] };
  const hasPrimary = columns.some((column) => column.priority === 'primary');
  const staysInRow = (column: T, index: number) =>
    hasPrimary ? column.priority === 'primary' : index === 0;
  return {
    rowColumns: columns.filter(staysInRow),
    detailColumns: columns.filter((column, index) => !staysInRow(column, index)),
  };
}
