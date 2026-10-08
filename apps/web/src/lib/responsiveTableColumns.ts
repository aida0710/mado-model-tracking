/** How important a column is: secondary columns move into the row's details on a narrow screen. */
export type ResponsiveColumnPriority = 'primary' | 'secondary';

export interface ColumnWithPriority {
  priority: ResponsiveColumnPriority;
}

/**
 * The columns a table shows as cells, and the ones it moves into each row's details. A wide
 * table shows every column; a narrow one keeps only the primary columns in the row.
 */
export function responsiveTableColumns<T extends ColumnWithPriority>(
  columns: readonly T[],
  isNarrow: boolean,
): { cells: T[]; details: T[] } {
  if (!isNarrow) return { cells: [...columns], details: [] };
  return {
    cells: columns.filter((column) => column.priority === 'primary'),
    details: columns.filter((column) => column.priority === 'secondary'),
  };
}
