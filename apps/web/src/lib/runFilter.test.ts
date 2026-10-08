import { describe, expect, it } from 'vitest';
import {
  findRunFilterSyntaxError,
  metricRunSort,
  runSortOrderBy,
  toRunSearchConditions,
} from './runFilter';

describe('Run検索の入力', () => {
  it('group.で始まる入力はfilterとしてAPIへ渡し、それ以外は名前検索にする', () => {
    expect(toRunSearchConditions('  metrics.loss < 0.1 ')).toEqual({
      filter: 'metrics.loss < 0.1',
    });
    expect(toRunSearchConditions("params.lr = '0.01'")).toEqual({ filter: "params.lr = '0.01'" });
    expect(toRunSearchConditions('training-A')).toEqual({ name: 'training-A' });
    expect(toRunSearchConditions('   ')).toEqual({});
  });

  it('APIが受け付ける式は送信前の検査で拒否しない', () => {
    for (const filter of [
      "metrics.`val/loss` < 0.1 AND params.batch_size = '32'",
      "tags.note = 'A and B' and params.lr != '0.1'",
      'tags.none IS NULL AND tags.team IS NOT NULL',
      "attributes.run_id IN ('a','b') AND datasets.name NOT IN ('x')",
      'attributes.status = "RUNNING" AND tags.owner ILIKE \'ai%\'',
      'metrics.score >= -1.5e-3',
    ])
      expect(findRunFilterSyntaxError(filter)).toBeNull();
  });

  it('構文エラーを送信前に検出し、位置を示す', () => {
    expect(findRunFilterSyntaxError('metrics.loss < nope')).toContain('16文字目');
    expect(findRunFilterSyntaxError("tags.a = 'b' OR tags.a = 'c'")).toContain('14文字目');
    expect(findRunFilterSyntaxError('metrics.loss <')).not.toBeNull();
    expect(findRunFilterSyntaxError("params.lr = '0.1")).not.toBeNull();
    expect(findRunFilterSyntaxError('tags.a IS MISSING')).not.toBeNull();
    expect(findRunFilterSyntaxError("attributes.run_id IN 'a'")).not.toBeNull();
    expect(findRunFilterSyntaxError('metrics.loss < 1;')).not.toBeNull();
  });

  it('並び順をAPIのorderByに変換し、記号を含むmetric名を引用する', () => {
    expect(runSortOrderBy('newest')).toEqual([]);
    expect(runSortOrderBy('name')).toEqual(['attributes.run_name ASC']);
    expect(runSortOrderBy(metricRunSort('loss', 'asc'))).toEqual(['metrics.loss ASC']);
    expect(runSortOrderBy(metricRunSort('val/loss', 'desc'))).toEqual(['metrics.`val/loss` DESC']);
    expect(runSortOrderBy(metricRunSort('odd`name', 'asc'))).toEqual(['metrics.`odd``name` ASC']);
  });
});
