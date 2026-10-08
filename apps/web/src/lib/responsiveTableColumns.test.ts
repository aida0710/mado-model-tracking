import { describe, expect, it } from 'vitest';
import { responsiveTableColumns } from './responsiveTableColumns';

const columns = [
  { key: 'path', priority: 'primary' as const },
  { key: 'run', priority: 'secondary' as const },
  { key: 'size', priority: 'primary' as const },
  { key: 'created', priority: 'secondary' as const },
];

describe('responsiveTableColumns', () => {
  it('広い幅ではすべての列をセルに出し、行の詳細は持たない', () => {
    const { cells, details } = responsiveTableColumns(columns, false);
    expect(cells.map((column) => column.key)).toEqual(['path', 'run', 'size', 'created']);
    expect(details).toEqual([]);
  });

  it('狭い幅では primary の列だけ順番どおりにセルへ残し、secondary は行の詳細へ回す', () => {
    const { cells, details } = responsiveTableColumns(columns, true);
    expect(cells.map((column) => column.key)).toEqual(['path', 'size']);
    expect(details.map((column) => column.key)).toEqual(['run', 'created']);
  });
});
