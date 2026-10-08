import { describe, expect, it } from 'vitest';
import { splitColumnsByPriority, type ColumnPriority } from './responsiveColumns';

const column = (key: string, priority: ColumnPriority) => ({ key, priority });
const keys = (columns: { key: string }[]) => columns.map((item) => item.key);

describe('splitColumnsByPriority', () => {
  const columns = [
    column('name', 'primary'),
    column('created', 'secondary'),
    column('status', 'primary'),
    column('owner', 'secondary'),
  ];

  it('広い幅では全列を行に並べ、開いたときの列は無い', () => {
    const split = splitColumnsByPriority(columns, false);
    expect(keys(split.rowColumns)).toEqual(['name', 'created', 'status', 'owner']);
    expect(split.detailColumns).toEqual([]);
  });

  it('狭い幅では primary だけを行に残し、secondary を開いたときの列へ回す', () => {
    const split = splitColumnsByPriority(columns, true);
    expect(keys(split.rowColumns)).toEqual(['name', 'status']);
    expect(keys(split.detailColumns)).toEqual(['created', 'owner']);
  });

  it('primary が1列も無い表は、狭い幅でも先頭の列を行に残す', () => {
    const split = splitColumnsByPriority(
      [column('name', 'secondary'), column('created', 'secondary')],
      true,
    );
    expect(keys(split.rowColumns)).toEqual(['name']);
    expect(keys(split.detailColumns)).toEqual(['created']);
  });
});
