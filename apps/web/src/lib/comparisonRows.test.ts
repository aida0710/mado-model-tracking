import { describe, expect, it } from 'vitest';
import type { Run, RunComparison } from '@mmt/contracts';
import {
  buildComparisonTableRows,
  chooseBaselineRunId,
  filterComparisonRows,
  formatComparisonValue,
  isComparableRunCount,
  parseComparedRunIds,
} from './comparisonRows';

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    projectId: 'p',
    experimentId: 'e',
    name: `run-${id}`,
    kind: 'evaluation',
    status: 'finished',
    parameters: {},
    tags: {},
    latestMetrics: {},
    modelVersionId: null,
    codeVersionId: null,
    inputDatasetVersionIds: [],
    upstreamDatasetVersionIds: [],
    outputDatasetVersionIds: [],
    outputModelVersionIds: [],
    parentRunId: null,
    environment: {},
    createdBy: 'u',
    createdAt: '2026-10-08T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    error: null,
    ...overrides,
  };
}

const comparison: RunComparison = {
  runs: [
    run('a', { modelVersionId: 'mv1', inputDatasetVersionIds: ['dv1'] }),
    run('b', { modelVersionId: 'mv2', inputDatasetVersionIds: ['dv1'] }),
  ],
  baselineRunId: 'b',
  modelVersions: [
    { id: 'mv1', modelId: 'm', modelName: 'asr', version: '1' },
    { id: 'mv2', modelId: 'm', modelName: 'asr', version: '2' },
  ],
  datasetVersions: [
    {
      id: 'dv1',
      datasetId: 'd',
      namespace: 'speech',
      name: 'eval',
      version: 'v1',
      digest: 'x',
    },
  ],
  rows: [
    { namespace: 'params', key: 'lr', values: [0.1, 0.1] },
    {
      namespace: 'metrics',
      key: 'wer',
      values: [0.15, 0.2],
      deltaFromBaseline: [-0.05, 0],
      relativeDeltaFromBaseline: [-0.25, 0],
    },
    { namespace: 'tags', key: 'team', values: ['asr', null] },
  ],
  history: [
    {
      runId: 'a',
      key: 'wer',
      points: [{ x: 1, step: 1, value: 0.3, min: 0.3, max: 0.3, count: 1 }],
      sampled: false,
      totalPoints: 1,
      nanCount: 0,
      droppedPoints: 0,
    },
  ],
};

describe('比較表の行', () => {
  it('モデルバージョンと評価データセットバージョンの行を先頭に置き、APIの行順と差分を保つ', () => {
    const rows = buildComparisonTableRows(comparison);
    expect(rows.map((row) => row.id)).toEqual([
      'modelVersion',
      'datasetVersions',
      'params.lr',
      'metrics.wer',
      'tags.team',
    ]);
    expect(rows[0]!.values).toEqual(['asr@1', 'asr@2']);
    expect(rows[1]!.values).toEqual(['speech/eval@v1', 'speech/eval@v1']);
    expect(rows[3]!.deltas).toEqual([
      { delta: -0.05, relativeDelta: -0.25 },
      { delta: 0, relativeDelta: 0 },
    ]);
    expect(rows[2]!.deltas).toBeUndefined();
  });

  it('「差のある行だけ」は全Runで同じ値の行を除き、値の欠けたRunは差として扱う', () => {
    const rows = buildComparisonTableRows(comparison);
    expect(filterComparisonRows(rows, true).map((row) => row.id)).toEqual([
      'modelVersion',
      'metrics.wer',
      'tags.team',
    ]);
    expect(filterComparisonRows(rows, false)).toHaveLength(rows.length);
  });
});

describe('比較表のセルの表記', () => {
  it('metricの数値は差の列と同じ6桁に丸め、paramとtagは記録どおりに出す', () => {
    expect(formatComparisonValue('metrics', 0.9209516501760575)).toBe('0.920952');
    expect(formatComparisonValue('metrics', 24503275520)).toBe('24,503,300,000');
    expect(formatComparisonValue('params', 0.9209516501760575)).toBe('0.9209516501760575');
    expect(formatComparisonValue('metrics', null)).toBe('—');
    expect(formatComparisonValue('metrics', 'NaN')).toBe('NaN');
  });
});

describe('URLの比較条件', () => {
  it('runsは空要素と重複を除いて順を保ち、件数は2〜50件だけ比較できる', () => {
    expect(parseComparedRunIds('b,a,,b')).toEqual(['b', 'a']);
    expect(parseComparedRunIds(null)).toEqual([]);
    expect(isComparableRunCount(1)).toBe(false);
    expect(isComparableRunCount(2)).toBe(true);
    expect(isComparableRunCount(51)).toBe(false);
  });

  it('比較対象に無い基準Runは使わない', () => {
    expect(chooseBaselineRunId(['a', 'b'], 'b')).toBe('b');
    expect(chooseBaselineRunId(['a', 'b'], 'c')).toBeNull();
    expect(chooseBaselineRunId(['a', 'b'], null)).toBeNull();
  });
});
