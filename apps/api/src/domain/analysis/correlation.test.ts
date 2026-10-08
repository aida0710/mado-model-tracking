import { describe, expect, it } from 'vitest';
import { parameterCorrelation, pearsonCorrelation } from './correlation.js';
import { buildParameterMatrix } from './parameterMatrix.js';

describe('pearsonCorrelation', () => {
  it('完全な正・負の線形関係はそれぞれ 1 と -1 になる', () => {
    const xs = Float64Array.from([1, 2, 3, 4]);
    expect(pearsonCorrelation(xs, Float64Array.from([2, 4, 6, 8]))).toBeCloseTo(1);
    expect(pearsonCorrelation(xs, Float64Array.from([8, 6, 4, 2]))).toBeCloseTo(-1);
  });

  it('分散が0の列は相関を定義できないので null になる', () => {
    expect(pearsonCorrelation(Float64Array.from([5, 5, 5]), Float64Array.from([1, 2, 3]))).toBeNull();
  });

  it('NaN の組を除いて計算し、残りが2未満なら null になる', () => {
    expect(
      pearsonCorrelation(Float64Array.from([1, Number.NaN, 2, 3]), Float64Array.from([1, 100, 2, 3])),
    ).toBeCloseTo(1);
    expect(pearsonCorrelation(Float64Array.from([1, Number.NaN]), Float64Array.from([1, 2]))).toBeNull();
  });
});

describe('parameterCorrelation', () => {
  it('カテゴリ列は水準ごとの相関のうち絶対値が最大のものを符号付きで返す', () => {
    // 'slow' だけ loss が高いので、'slow' の one-hot 列が最も強い正の相関を持つ。
    const matrix = buildParameterMatrix({
      runs: [
        { parameters: { optimizer: 'adam' }, metrics: { loss: 1 } },
        { parameters: { optimizer: 'adam' }, metrics: { loss: 1.1 } },
        { parameters: { optimizer: 'sgd' }, metrics: { loss: 1.2 } },
        { parameters: { optimizer: 'sgd' }, metrics: { loss: 1.3 } },
        { parameters: { optimizer: 'slow' }, metrics: { loss: 5 } },
        { parameters: { optimizer: 'slow' }, metrics: { loss: 5.2 } },
      ],
      objectiveMetric: 'loss',
      parameterNames: ['optimizer'],
    });
    const column = matrix.columns[0]!;
    const perLevel = column.features.map((feature) => pearsonCorrelation(feature.values, matrix.objective)!);
    const correlation = parameterCorrelation(column, matrix.objective)!;
    expect(correlation).toBeGreaterThan(0);
    expect(Math.abs(correlation)).toBeCloseTo(Math.max(...perLevel.map(Math.abs)));
  });

  it('負の効果が最も強い水準なら負の相関を返す', () => {
    const matrix = buildParameterMatrix({
      runs: [
        { parameters: { optimizer: 'adam' }, metrics: { loss: 0 } },
        { parameters: { optimizer: 'adam' }, metrics: { loss: 0.1 } },
        { parameters: { optimizer: 'sgd' }, metrics: { loss: 5 } },
        { parameters: { optimizer: 'sgd' }, metrics: { loss: 5.1 } },
        { parameters: { optimizer: 'rms' }, metrics: { loss: 5.2 } },
        { parameters: { optimizer: 'rms' }, metrics: { loss: 5 } },
      ],
      objectiveMetric: 'loss',
      parameterNames: ['optimizer'],
    });
    expect(parameterCorrelation(matrix.columns[0]!, matrix.objective)!).toBeLessThan(-0.9);
  });
});
