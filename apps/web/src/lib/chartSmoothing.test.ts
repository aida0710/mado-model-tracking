import { describe, expect, it } from 'vitest';
import { smoothValues } from './chartSmoothing';

const values = [1, 2, 3, 10, 4, 5];

describe('メトリクスの平滑化', () => {
  it.each(['ema', 'gaussian', 'running_average'] as const)(
    '重み0の%sは元の値をそのまま返す',
    (kind) => {
      expect(smoothValues(values, { kind, weight: 0 })).toEqual(values);
    },
  );

  it('EMAはW&Bと同じdebiasを掛け、最初の点を0へ引き寄せない', () => {
    // last = last*w + (1-w)*y を 1 - w^n で割る: 0.5/0.5, 1.25/0.75, 2.125/0.875
    const smoothed = smoothValues([1, 2, 3], { kind: 'ema', weight: 0.5 });
    expect(smoothed[0]).toBeCloseTo(1);
    expect(smoothed[1]).toBeCloseTo(5 / 3);
    expect(smoothed[2]).toBeCloseTo(17 / 7);
  });

  it('EMAの重みは0.999で頭打ちにし、重み1でも線が値を追う', () => {
    const smoothed = smoothValues([0, 10], { kind: 'ema', weight: 1 });
    expect(smoothed[1]).toBeCloseTo((0.001 * 10) / (1 - 0.999 ** 2));
  });

  it('NaNと無限大は出力でNaNのまま飛ばし、平滑化の状態を壊さない', () => {
    const smoothed = smoothValues([1, Number.NaN, 2, Number.POSITIVE_INFINITY, 3], {
      kind: 'ema',
      weight: 0.5,
    });
    expect(smoothed[1]).toBeNaN();
    expect(smoothed[3]).toBeNaN();
    expect(smoothed[2]).toBeCloseTo(5 / 3);
    expect(smoothed[4]).toBeCloseTo(17 / 7);
  });

  it('ガウスは端で窓を切って正規化し直すので、一定の系列は端でも一定のまま', () => {
    const smoothed = smoothValues([5, 5, 5, 5, 5], { kind: 'gaussian', weight: 1 });
    for (const value of smoothed) expect(value).toBeCloseTo(5);
  });

  it('ガウスは山を左右対称に均し、NaNの点は近傍に含めない', () => {
    const smoothed = smoothValues([0, 0, 10, Number.NaN, 0, 0], { kind: 'gaussian', weight: 0.05 });
    expect(smoothed[3]).toBeNaN();
    expect(smoothed[2]).toBeLessThan(10);
    expect(smoothed[1]).toBeCloseTo(smoothed[4]!);
    expect(smoothed[1]).toBeGreaterThan(0);
  });

  it('移動平均は直前までの有限な点の平均で、窓の外の点を含めない', () => {
    // 重み1/99で窓は2点
    const smoothed = smoothValues([2, 4, Number.NaN, 8], {
      kind: 'running_average',
      weight: 1 / 99,
    });
    expect(smoothed).toEqual([2, 3, Number.NaN, 6]);
  });

  it('平滑化なしは重みにかかわらず元の値を返す', () => {
    expect(smoothValues(values, { kind: 'none', weight: 0.9 })).toEqual(values);
  });
});
