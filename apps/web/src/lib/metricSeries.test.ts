import { describe, expect, it } from 'vitest';
import { buildMetricRows } from './metricSeries';

describe('メトリクスの比較', () => {
  it('欠損したstepを補完せず、同じstepの更新は最新時刻の値を表示する', () => {
    const rows = buildMetricRows(
      [
        {
          id: 'a',
          label: 'A',
          points: [
            { name: 'loss', value: 0.2, step: 1, timestamp: '2026-10-08T00:01:00Z' },
            { name: 'loss', value: 0.4, step: 1, timestamp: '2026-10-08T00:00:00Z' },
          ],
        },
        {
          id: 'b',
          label: 'B',
          points: [{ name: 'loss', value: 0.8, step: 2, timestamp: '2026-10-08T00:02:00Z' }],
        },
      ],
      'loss',
    );
    expect(rows).toEqual([
      { step: 1, a: 0.2 },
      { step: 2, b: 0.8 },
    ]);
  });
});
