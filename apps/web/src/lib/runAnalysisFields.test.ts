import { ANALYSIS_MAX_METRICS, type RunAnalysisTableResponse } from '@mmt/contracts';
import { describe, expect, it } from 'vitest';
import {
  analysisRows,
  defaultParamAxisKeys,
  metricFields,
  paramFields,
  resolveAnalysisTarget,
  tableMetricKeys,
} from './runAnalysisFields';

const sweepTable: RunAnalysisTableResponse = {
  runs: [
    {
      runId: 'r1',
      name: 'trial-1',
      experimentId: 'e',
      status: 'finished',
      params: { lr: 0.1, loss: 'param-named-loss' },
      metrics: { loss: 0.5 },
      objective: null,
    },
  ],
  params: [
    { key: 'lr', kind: 'numeric', coverage: 1 },
    { key: 'loss', kind: 'categorical', values: ['param-named-loss'], coverage: 0.5 },
  ],
  metrics: [{ key: 'loss', min: 0.5, max: 0.5 }],
  objective: { metric: 'loss', goal: 'minimize', aggregation: 'last', min: null, max: null },
};

describe('分析の表から図の行と項目を作る', () => {
  it('同じ名前のparamとmetricを区別し、objectiveの欠損はnullのまま残す', () => {
    expect(analysisRows(sweepTable)).toEqual([
      {
        runId: 'r1',
        name: 'trial-1',
        values: { 'params.lr': 0.1, 'params.loss': 'param-named-loss', 'metrics.loss': 0.5, objective: null },
      },
    ]);
  });

  it('カテゴリparamはAPIの値の一覧を軸のカテゴリにし、Sweepではobjectiveを先頭のmetric項目にする', () => {
    expect(paramFields(sweepTable)[1]).toEqual({
      key: 'params.loss',
      label: 'loss',
      kind: 'categorical',
      categories: ['param-named-loss'],
    });
    expect(metricFields(sweepTable, 'objective').map((field) => field.key)).toEqual(['objective', 'metrics.loss']);
  });

  it('既定の軸は重要度の順、重要度が無ければcoverageの高い順に選ぶ', () => {
    expect(defaultParamAxisKeys(sweepTable, undefined)).toEqual(['params.lr', 'params.loss']);
    const importance = {
      entries: [{ param: 'loss' }, { param: 'not-in-table' }, { param: 'lr' }],
    } as Parameters<typeof defaultParamAxisKeys>[1];
    expect(defaultParamAxisKeys(sweepTable, importance)).toEqual(['params.loss', 'params.lr']);
  });
});

describe('分析の目的metric', () => {
  it('既定はSweepならobjective、それ以外は名前順で最初のmetricになる', () => {
    expect(resolveAnalysisTarget(null, { metricKeys: ['acc', 'loss'], objectiveMetric: 'loss' })).toEqual({
      source: 'sweep_objective',
    });
    expect(resolveAnalysisTarget(null, { metricKeys: ['acc', 'loss'], objectiveMetric: null })).toEqual({
      source: 'latest_metric',
      metric: 'acc',
    });
    expect(resolveAnalysisTarget(null, { metricKeys: [], objectiveMetric: null })).toBeNull();
  });

  it('選んだ目的がRun集合に無くなれば既定に戻る', () => {
    const options = { metricKeys: ['acc', 'loss'], objectiveMetric: null };
    const loss = { source: 'latest_metric', metric: 'loss' } as const;
    expect(resolveAnalysisTarget(loss, options)).toEqual(loss);
    expect(resolveAnalysisTarget({ source: 'latest_metric', metric: 'gone' }, options)).toEqual({
      source: 'latest_metric',
      metric: 'acc',
    });
    expect(resolveAnalysisTarget({ source: 'sweep_objective' }, options)).toEqual({ source: 'latest_metric', metric: 'acc' });
  });

  it('metricが上限を超えても目的metricは表の取得に必ず含める', () => {
    const keys = Array.from({ length: ANALYSIS_MAX_METRICS + 10 }, (_, index) => `m${String(index).padStart(3, '0')}`);
    const requested = tableMetricKeys(keys, { source: 'latest_metric', metric: 'm055' });
    expect(requested).toHaveLength(ANALYSIS_MAX_METRICS);
    expect(requested[0]).toBe('m055');
    expect(tableMetricKeys(keys, { source: 'sweep_objective' })).toEqual(keys.slice(0, ANALYSIS_MAX_METRICS));
  });
});
