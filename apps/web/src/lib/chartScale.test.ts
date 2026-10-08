import { describe, expect, it } from 'vitest';
import { bandPath, keepPlottablePoints, linePath, paddedDomain, xExtent } from './chartScale';

describe('図の軸の範囲', () => {
  it('y軸が対数なら0以下の値の点を除き、除いた件数を返す', () => {
    const result = keepPlottablePoints(
      [
        { x: 1, value: 0.5 },
        { x: 2, value: 0 },
        { x: 3, value: -1 },
        { x: 4, value: 2 },
      ],
      { xScale: 'linear', yScale: 'log' },
    );
    expect(result.points.map((point) => point.x)).toEqual([1, 4]);
    expect(result.excludedCount).toBe(2);
  });

  it('x軸が対数ならstep 0の点を除いて数える', () => {
    const result = keepPlottablePoints(
      [
        { x: 0, value: 1 },
        { x: 1, value: 1 },
      ],
      { xScale: 'log', yScale: 'linear' },
    );
    expect(result).toEqual({ points: [{ x: 1, value: 1 }], excludedCount: 1 });
  });

  it('対数軸で下端が0以下の帯はその点の帯だけを落とし、線の値は残す', () => {
    const result = keepPlottablePoints([{ x: 1, value: 1, min: 0, max: 2 }], {
      xScale: 'linear',
      yScale: 'log',
    });
    expect(result).toEqual({ points: [{ x: 1, value: 1 }], excludedCount: 0 });
  });

  it('線形軸では値を置き換えも除外もしない', () => {
    const points = [{ x: 0, value: -3 }];
    expect(keepPlottablePoints(points, { xScale: 'linear', yScale: 'linear' })).toEqual({
      points,
      excludedCount: 0,
    });
  });

  it('y軸の範囲は非有限の値を無視して上下に余白を足す', () => {
    expect(paddedDomain([0, 10, Number.NaN, Number.POSITIVE_INFINITY], 'linear')).toEqual([
      -0.5, 10.5,
    ]);
    expect(paddedDomain([Number.NaN], 'linear')).toBeNull();
  });

  it('対数のy軸の範囲は0以下を無視して倍率で余白を足す', () => {
    const domain = paddedDomain([-1, 0, 1, 100], 'log')!;
    expect(domain[0]).toBeLessThan(1);
    expect(domain[0]).toBeGreaterThan(0.5);
    expect(domain[1]).toBeGreaterThan(100);
  });

  it('x軸が1点だけでも描ける幅を持たせる', () => {
    expect(xExtent([5, 5], 'linear')).toEqual([4, 6]);
    expect(xExtent([3, 9], 'linear')).toEqual([3, 9]);
  });
});

describe('線と帯のpath', () => {
  const scales = { x: (value: number) => value * 10, y: (value: number) => 100 - value };

  it('置けない値で線を切り、欠けた所を直線でつながない', () => {
    expect(linePath([0, 1, 2, 3], [1, Number.NaN, 2, 3], scales)).toBe(
      'M0.0,99.0M20.0,98.0L30.0,97.0',
    );
  });

  it('帯は上端を進んで下端を戻る閉じた形で、帯の無い点で区切る', () => {
    expect(
      bandPath(
        [
          { x: 0, value: 1, min: 0, max: 2 },
          { x: 1, value: 1, min: 0, max: 2 },
          { x: 2, value: 1 },
        ],
        scales,
      ),
    ).toBe('M0.0,98.0L10.0,98.0L10.0,100.0L0.0,100.0Z');
  });
});
