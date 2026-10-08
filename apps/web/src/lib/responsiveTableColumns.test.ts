import { describe, expect, it } from 'vitest';
import { splitColumnsByPriority } from './responsiveTableColumns';

const columns = [
  { key: 'name', priority: 'primary' as const },
  { key: 'email', priority: 'secondary' as const },
  { key: 'role', priority: 'primary' as const },
  { key: 'created', priority: 'secondary' as const },
];

describe('splitColumnsByPriority', () => {
  it('広い幅ではすべての列を表のセルに出し、行の詳細には何も畳まない', () => {
    const { cellColumns, detailColumns } = splitColumnsByPriority(columns, false);
    expect(cellColumns.map((column) => column.key)).toEqual(['name', 'email', 'role', 'created']);
    expect(detailColumns).toEqual([]);
  });

  it('狭い幅では primary の列だけをセルに残し、secondary は元の順のまま詳細へ回す', () => {
    const { cellColumns, detailColumns } = splitColumnsByPriority(columns, true);
    expect(cellColumns.map((column) => column.key)).toEqual(['name', 'role']);
    expect(detailColumns.map((column) => column.key)).toEqual(['email', 'created']);
  });
});
