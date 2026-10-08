import { describe, expect, it } from 'vitest';
import { splitColumnsByPriority, type ColumnPriority } from './responsiveColumns';

const columns: Array<{ key: string; priority: ColumnPriority }> = [
  { key: 'id', priority: 'primary' },
  { key: 'target', priority: 'secondary' },
  { key: 'status', priority: 'primary' },
  { key: 'created', priority: 'secondary' },
];

describe('splitColumnsByPriority', () => {
  it('keeps every column in the row on a wide window', () => {
    const { shown, folded } = splitColumnsByPriority(columns, false);
    expect(shown.map((column) => column.key)).toEqual(['id', 'target', 'status', 'created']);
    expect(folded).toEqual([]);
  });

  it('keeps the primary columns in order and folds the rest on a narrow window', () => {
    const { shown, folded } = splitColumnsByPriority(columns, true);
    expect(shown.map((column) => column.key)).toEqual(['id', 'status']);
    expect(folded.map((column) => column.key)).toEqual(['target', 'created']);
  });
});
