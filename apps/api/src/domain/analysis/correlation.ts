import type { ParameterColumn } from './parameterMatrix.js';

/**
 * Pearson の相関係数。どちらかが NaN の Run は除いて計算する。
 * 有効な組が2未満、またはどちらかの分散が0なら定義できないので null。
 */
export function pearsonCorrelation(xs: Float64Array, ys: Float64Array): number | null {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index]!;
    const y = ys[index]!;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    count += 1;
    sumX += x;
    sumY += y;
  }
  if (count < 2) return null;
  const meanX = sumX / count;
  const meanY = sumY / count;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index]!;
    const y = ys[index]!;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    covariance += (x - meanX) * (y - meanY);
    varianceX += (x - meanX) ** 2;
    varianceY += (y - meanY) ** 2;
  }
  if (varianceX === 0 || varianceY === 0) return null;
  // 丸め誤差で |r| が 1 をわずかに超えるのを防ぐ。
  return Math.max(-1, Math.min(1, covariance / Math.sqrt(varianceX * varianceY)));
}

/**
 * parameter と目的メトリクスの相関。
 * 数値列は値そのものの相関。カテゴリ列は W&B の表示に合わせ、水準ごとの one-hot 列の相関のうち
 * 絶対値が最大のものを符号付きで返す。
 */
export function parameterCorrelation(column: ParameterColumn, objective: Float64Array): number | null {
  if (column.kind === 'numeric') {
    const numeric = column.features.find((feature) => feature.kind === 'numeric');
    return numeric ? pearsonCorrelation(numeric.values, objective) : null;
  }
  let strongest: number | null = null;
  for (const feature of column.features) {
    const correlation = pearsonCorrelation(feature.values, objective);
    if (correlation !== null && (strongest === null || Math.abs(correlation) > Math.abs(strongest))) {
      strongest = correlation;
    }
  }
  return strongest;
}
