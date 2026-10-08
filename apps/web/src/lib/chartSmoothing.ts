import type { ChartSmoothing } from '@mmt/contracts';

// W&B caps the EMA weight below 1 so the line still moves with new values.
export const MAX_EMA_WEIGHT = 0.999;
// At weight 1 the Gaussian kernel spans about ±60 points, a few percent of a 1000-point series.
const GAUSSIAN_MAX_SIGMA_POINTS = 20;
// The kernel is cut at 3 sigma, where its weight is below 0.5% of the center.
const GAUSSIAN_CUTOFF_SIGMAS = 3;
// At weight 1 the running average covers the last 100 points.
const RUNNING_AVERAGE_MAX_WINDOW = 100;

/**
 * Smooths values in point order and returns one value per input. Non-finite inputs stay NaN in the
 * output and are skipped, so they neither reset nor pull the smoothed line. Uneven x spacing is
 * not weighted: like W&B, each method works on the order of the points.
 */
export function smoothValues(values: readonly number[], smoothing: ChartSmoothing): number[] {
  const weight = Math.min(Math.max(smoothing.weight, 0), 1);
  if (smoothing.kind === 'none' || weight === 0) return [...values];
  if (smoothing.kind === 'ema') return smoothEma(values, weight);
  if (smoothing.kind === 'gaussian') return smoothGaussian(values, weight);
  return smoothRunningAverage(values, weight);
}

/**
 * Debiased exponential moving average, the same formula as W&B and TensorBoard:
 * `last = last * w + (1 - w) * y`, shown as `last / (1 - w^n)` after n finite values, so the first
 * points are not pulled toward 0.
 */
function smoothEma(values: readonly number[], weight: number): number[] {
  const w = Math.min(weight, MAX_EMA_WEIGHT);
  let last = 0;
  let finiteCount = 0;
  return values.map((value) => {
    if (!Number.isFinite(value)) return Number.NaN;
    last = last * w + (1 - w) * value;
    finiteCount += 1;
    return last / (1 - w ** finiteCount);
  });
}

/**
 * Gaussian kernel over the neighboring finite points. At the ends the kernel is cut and renormalized
 * over the points that exist, so a constant series stays constant instead of bending toward 0.
 */
function smoothGaussian(values: readonly number[], weight: number): number[] {
  const sigma = weight * GAUSSIAN_MAX_SIGMA_POINTS;
  const radius = Math.ceil(sigma * GAUSSIAN_CUTOFF_SIGMAS);
  const kernel = Array.from({ length: radius + 1 }, (_, offset) =>
    Math.exp(-(offset * offset) / (2 * sigma * sigma)),
  );
  const finiteIndexes = finiteValueIndexes(values);
  const output = values.map(() => Number.NaN);
  finiteIndexes.forEach((valueIndex, position) => {
    let weightedSum = 0;
    let weightSum = 0;
    const first = Math.max(0, position - radius);
    const last = Math.min(finiteIndexes.length - 1, position + radius);
    for (let neighbor = first; neighbor <= last; neighbor += 1) {
      const kernelWeight = kernel[Math.abs(neighbor - position)]!;
      weightedSum += kernelWeight * values[finiteIndexes[neighbor]!]!;
      weightSum += kernelWeight;
    }
    output[valueIndex] = weightedSum / weightSum;
  });
  return output;
}

/** Mean of the current finite point and the finite points before it, up to the window size. */
function smoothRunningAverage(values: readonly number[], weight: number): number[] {
  const windowSize = 1 + Math.round(weight * (RUNNING_AVERAGE_MAX_WINDOW - 1));
  const window: number[] = [];
  let windowSum = 0;
  return values.map((value) => {
    if (!Number.isFinite(value)) return Number.NaN;
    window.push(value);
    windowSum += value;
    if (window.length > windowSize) windowSum -= window.shift()!;
    return windowSum / window.length;
  });
}

function finiteValueIndexes(values: readonly number[]): number[] {
  const indexes: number[] = [];
  values.forEach((value, index) => {
    if (Number.isFinite(value)) indexes.push(index);
  });
  return indexes;
}
