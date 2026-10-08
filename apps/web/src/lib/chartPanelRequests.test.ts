import { describe, expect, it } from 'vitest';
import { DEFAULT_SERIES_POINTS, MAX_SERIES_KEYS, type ChartPanelConfig } from '@mmt/contracts';
import { createPanelConfig } from './chartPanelLayout';
import {
  chunkMetricKeys,
  MIN_POINTS_PER_SERIES,
  planChartRequests,
  pointsPerSeries,
} from './chartPanelRequests';

const panel = (id: string, keys: string[], changes: Partial<ChartPanelConfig> = {}): ChartPanelConfig => ({
  ...createPanelConfig(keys),
  id,
  layout: { x: 0, y: 0, w: 4, h: 2 },
  ...changes,
});

describe('planChartRequests', () => {
  it('fetches every panel on the same x axis with one request', () => {
    const plans = planChartRequests([panel('a', ['loss', 'lr']), panel('b', ['loss', 'acc'])], true);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ kind: 'series', keys: ['loss', 'lr', 'acc'] });
  });

  it('separates panels by x axis and by grouping', () => {
    const plans = planChartRequests(
      [
        panel('a', ['loss']),
        panel('b', ['loss'], { xAxis: { kind: 'relative_time' } }),
        panel('c', ['loss'], { groupBy: { kind: 'tag', key: 'model' } }),
      ],
      true,
    );
    expect(plans.map((plan) => [plan.kind, plan.xAxis.kind])).toEqual([
      ['series', 'step'],
      ['series', 'relative_time'],
      ['groups', 'step'],
    ]);
  });

  it('draws a grouped panel Run by Run where grouping is unavailable', () => {
    const plans = planChartRequests([panel('a', ['loss'], { groupBy: { kind: 'experiment' } })], false);
    expect(plans).toEqual([expect.objectContaining({ kind: 'series' })]);
    expect(plans[0]).not.toHaveProperty('groupBy');
  });
});

describe('request sizes', () => {
  it('splits keys into chunks the API accepts', () => {
    const keys = Array.from({ length: MAX_SERIES_KEYS + 1 }, (_, index) => `m${index}`);
    expect(chunkMetricKeys(keys).map((chunk) => chunk.length)).toEqual([MAX_SERIES_KEYS, 1]);
  });

  it('lowers the points per line as lines increase, within bounds', () => {
    expect(pointsPerSeries(1)).toBe(DEFAULT_SERIES_POINTS);
    expect(pointsPerSeries(50 * 24)).toBe(166);
    expect(pointsPerSeries(100_000)).toBe(MIN_POINTS_PER_SERIES);
  });
});
