import { describe, expect, it } from 'vitest';
import type { Run } from '@mmt/contracts';
import { matchesRunFilter, parseRunFilter } from './runFilter';

const run = {
  name: 'training-A',
  latestMetrics: { 'val/loss': 0.09 },
  parameters: { batch_size: 32, speaker: true },
  tags: { note: 'A and B' },
} as unknown as Run;
describe('Runの絞り込み', () => {
  it('数値・真偽値の条件をすべて満たすRunだけが一致する', () => {
    expect(
      matchesRunFilter(
        run,
        parseRunFilter(
          'metrics.val/loss < 0.1 and params.batch_size = 32 and params.speaker = true',
        ),
      ),
    ).toBe(true);
    expect(matchesRunFilter(run, parseRunFilter('metrics.val/loss <= 0.01'))).toBe(false);
  });
  it('引用したタグの中のandを条件区切りとして扱わない', () => {
    expect(
      matchesRunFilter(run, parseRunFilter('tags.note = "A and B" and params.batch_size >= 16')),
    ).toBe(true);
  });
  it('欠損したメトリクスを不一致にし、数値文字列を数値とみなさない', () => {
    expect(matchesRunFilter(run, parseRunFilter('metrics.missing != 0'))).toBe(false);
    expect(
      matchesRunFilter(
        { ...run, parameters: { batch_size: '32' } },
        parseRunFilter('params.batch_size = 32'),
      ),
    ).toBe(false);
  });
  it('壊れた比較式を名前検索として黙って処理しない', () => {
    expect(() => parseRunFilter('metrics.val/loss < nope')).toThrow();
  });
});
