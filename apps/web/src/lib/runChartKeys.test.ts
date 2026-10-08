import { describe, expect, it } from 'vitest';
import { RUN_NOTE_TAG, type Run } from '@mmt/contracts';
import { getRunChartKeys } from './runChartKeys';

const run = (changes: Partial<Run>) =>
  ({ latestMetrics: {}, tags: {}, parameters: {}, recordedParameters: {}, ...changes }) as Run;

describe('getRunChartKeys', () => {
  it('offers the metrics, tags and params of all Runs once, without system metrics', () => {
    const keys = getRunChartKeys([
      run({ latestMetrics: { loss: 1, 'system.cpu.percent': 3 }, tags: { model: 'a' }, parameters: { lr: 0.1 } }),
      run({ latestMetrics: { 'eval/wer': 0.2, loss: 2 }, tags: { model: 'b', [RUN_NOTE_TAG]: '# note' }, recordedParameters: { seed: '1' } }),
    ]);
    expect(keys).toEqual({
      metricKeys: ['eval/wer', 'loss'],
      tagKeys: ['model'],
      paramKeys: ['lr', 'seed'],
    });
  });
});
