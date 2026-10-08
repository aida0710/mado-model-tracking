import { describe, expect, it } from 'vitest';
import { groupRuns } from './runGrouping.js';

describe('Runのグループ分け', () => {
  it('値ごとにまとめ、数値は数の順、値の無いRunは最後の(none)にする', () => {
    expect(
      groupRuns([
        { runId: 'a', value: '0.01' },
        { runId: 'b', value: null },
        { runId: 'c', value: '0.001' },
        { runId: 'd', value: '0.01' },
        { runId: 'e', value: '0.1' },
      ]),
    ).toEqual([
      { groupKey: '0.001', label: '0.001', runIds: ['c'] },
      { groupKey: '0.01', label: '0.01', runIds: ['a', 'd'] },
      { groupKey: '0.1', label: '0.1', runIds: ['e'] },
      { groupKey: '(none)', label: '(none)', runIds: ['b'] },
    ]);
  });

  it('Experimentはnameをlabelにし、IDをgroupKeyに残す', () => {
    expect(
      groupRuns([
        { runId: 'a', value: 'experiment-2', label: 'baseline' },
        { runId: 'b', value: 'experiment-1', label: 'ablation' },
      ]),
    ).toEqual([
      { groupKey: 'experiment-1', label: 'ablation', runIds: ['b'] },
      { groupKey: 'experiment-2', label: 'baseline', runIds: ['a'] },
    ]);
  });

  it('値が文字どおり(none)のRunは値の無いグループに入り、groupKeyが重ならない', () => {
    expect(
      groupRuns([
        { runId: 'a', value: '(none)' },
        { runId: 'b', value: null },
      ]),
    ).toEqual([{ groupKey: '(none)', label: '(none)', runIds: ['a', 'b'] }]);
  });

  it('Runが無ければグループも無い', () => {
    expect(groupRuns([])).toEqual([]);
  });
});
