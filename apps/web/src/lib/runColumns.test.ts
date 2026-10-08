import { describe, expect, it } from 'vitest';
import {
  defaultRunColumns,
  descriptionSummary,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  moveColumn,
  resizeColumn,
  shiftColumn,
  toggleColumn,
} from './runColumns';

const keys = (columns: { key: string }[]) => columns.map((column) => column.key);

describe('Run一覧の列', () => {
  it('既定の列は状態・日時・時間、先頭2つずつのメトリクスとパラメータ、ユーザー', () => {
    expect(keys(defaultRunColumns(['acc', 'loss', 'wer'], ['lr', 'seed', 'bs']))).toEqual([
      'status',
      'created',
      'duration',
      'metrics.acc',
      'metrics.loss',
      'params.lr',
      'params.seed',
      'user',
    ]);
  });

  it('表示を切り替えると、出す列は末尾に足し、隠す列は幅ごと消す', () => {
    const columns = [{ key: 'status', width: 90 }, { key: 'user' }];
    expect(toggleColumn(columns, 'description')).toEqual([...columns, { key: 'description' }]);
    expect(toggleColumn(columns, 'status')).toEqual([{ key: 'user' }]);
  });

  it('列を移すと、移した先との間の列がずれ、幅は列について回る', () => {
    const columns = [{ key: 'a' }, { key: 'b', width: 80 }, { key: 'c' }];
    expect(moveColumn(columns, 'c', 'a')).toEqual([{ key: 'c' }, { key: 'a' }, { key: 'b', width: 80 }]);
    expect(moveColumn(columns, 'a', 'missing')).toBe(columns);
    expect(keys(shiftColumn(columns, 'b', 1))).toEqual(['a', 'c', 'b']);
    expect(shiftColumn(columns, 'a', -1)).toBe(columns);
  });

  it('幅は整数にし、狭すぎ・広すぎは上下限に収める', () => {
    const columns = [{ key: 'a' }];
    expect(resizeColumn(columns, 'a', 151.6)).toEqual([{ key: 'a', width: 152 }]);
    expect(resizeColumn(columns, 'a', 3)).toEqual([{ key: 'a', width: MIN_COLUMN_WIDTH }]);
    expect(resizeColumn(columns, 'a', 99999)).toEqual([{ key: 'a', width: MAX_COLUMN_WIDTH }]);
  });

  it('説明列は最初の空でない行を見出しや箇条書きの記号なしで出す', () => {
    expect(descriptionSummary('\n\n## 学習条件\n\n詳細')).toBe('学習条件');
    expect(descriptionSummary('- lr を下げた')).toBe('lr を下げた');
    expect(descriptionSummary('')).toBe('');
  });
});
