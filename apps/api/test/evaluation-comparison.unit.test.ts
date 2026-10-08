import { describe, expect, it } from 'vitest';
import { compareMetrics } from '../src/domain/evaluationComparison.js';
import { referenceDatasetVersionIds } from '../src/domain/evaluationInputs.js';

const latest = (value: number) => ({ value, source: 'run_latest' as const });

describe('評価結果の比較（純粋関数）', () => {
  it('候補と基準の差と、基準の絶対値に対する相対差を返す', () => {
    const [accuracy, loss] = compareMetrics({
      candidate: { accuracy: latest(0.9), loss: latest(-0.3) },
      baseline: { accuracy: latest(0.8), loss: latest(-0.2) },
    });
    expect(accuracy).toMatchObject({ key: 'accuracy', candidate: 0.9, baseline: 0.8 });
    expect(accuracy!.delta).toBeCloseTo(0.1);
    expect(accuracy!.relativeDelta).toBeCloseTo(0.125);
    // 負の基準でも、相対差の符号は差の符号と同じになる。
    expect(loss!.delta).toBeCloseTo(-0.1);
    expect(loss!.relativeDelta).toBeCloseTo(-0.5);
  });

  it('基準が0なら差は返し、相対差はnullにする', () => {
    const [metric] = compareMetrics({ candidate: { wer: latest(0.2) }, baseline: { wer: latest(0) } });
    expect(metric).toMatchObject({ delta: 0.2, relativeDelta: null });
  });

  it('NaNと無限大はnot_finiteとして示し、差を計算しない', () => {
    const metrics = compareMetrics({
      candidate: { a: latest(Number.NaN), b: latest(1) },
      baseline: { a: latest(1), b: latest(Number.POSITIVE_INFINITY) },
    });
    expect(metrics).toEqual([
      expect.objectContaining({
        key: 'a',
        candidate: null,
        candidateStatus: 'not_finite',
        baselineStatus: 'present',
        delta: null,
        relativeDelta: null,
      }),
      expect.objectContaining({ key: 'b', baseline: null, baselineStatus: 'not_finite', delta: null }),
    ]);
    expect(JSON.parse(JSON.stringify(metrics))).toEqual(metrics);
  });

  it('片側だけにあるmetricはmissingとして並べ、指定がなければ名前順にする', () => {
    const metrics = compareMetrics({
      candidate: { zeta: latest(1) },
      baseline: { alpha: { value: 2, source: 'dataset_context' } },
    });
    expect(metrics.map((metric) => [metric.key, metric.candidateStatus, metric.baselineStatus])).toEqual([
      ['alpha', 'missing', 'present'],
      ['zeta', 'present', 'missing'],
    ]);
    expect(metrics[0]!.source).toEqual({ candidate: null, baseline: 'dataset_context' });
  });

  it('基準の評価がないとき（null）は全metricの基準がmissingになり、指定したkeyだけを返す', () => {
    const metrics = compareMetrics({
      candidate: { accuracy: latest(0.9), loss: latest(0.1) },
      baseline: null,
      metricKeys: ['loss', 'unknown'],
    });
    expect(metrics.map((metric) => [metric.key, metric.candidateStatus, metric.baselineStatus])).toEqual([
      ['loss', 'present', 'missing'],
      ['unknown', 'missing', 'missing'],
    ]);
  });

  it('Objectの組み込みプロパティ名をmetricとして扱わない', () => {
    const [metric] = compareMetrics({ candidate: {}, baseline: {}, metricKeys: ['toString'] });
    expect(metric).toMatchObject({ candidateStatus: 'missing', baselineStatus: 'missing' });
  });
});

describe('正解セット（入力から上流出力を除いたもの）', () => {
  it('入力から上流出力を除き、重複を除いて並べる', () => {
    expect(
      referenceDatasetVersionIds({
        inputDatasetVersionIds: ['c', 'a', 'prediction', 'a'],
        upstreamDatasetVersionIds: ['prediction'],
      }),
    ).toEqual(['a', 'c']);
  });

  it('上流出力が空の手動Runでは、全入力が正解セットになる', () => {
    expect(
      referenceDatasetVersionIds({ inputDatasetVersionIds: ['b', 'a'], upstreamDatasetVersionIds: [] }),
    ).toEqual(['a', 'b']);
  });
});
