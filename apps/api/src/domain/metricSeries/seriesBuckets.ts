import type { MetricSeriesPoint, MetricXRange } from '@mmt/contracts';

/** Where the x values of one series, or of one key across Runs, fall inside the requested range. */
export interface SeriesExtent {
  xMin: number | null;
  xMax: number | null;
  /** Points with an x value, NaN and infinite values included. */
  totalPoints: number;
}
/** `raw` returns every stored point; `buckets` splits [lower, upper] into `count` equal widths. */
export type BucketPlan =
  | { kind: 'raw' }
  | { kind: 'buckets'; lower: number; upper: number; count: number };
/** One SQL bucket before NaN-only buckets are removed; finite statistics are null for those. */
export interface SeriesBucketRow {
  x: number | null;
  step: number | null;
  value: number | null;
  minValue: number | null;
  maxValue: number | null;
  count: number;
  nanCount: number;
}

// width_bucket needs distinct bounds; a single x value (one step, or xRange of one point) still
// needs a bucket that contains it, and any positive width puts it in the first bucket.
const SINGLE_VALUE_BUCKET_WIDTH = 1;

/** The requested range wins over the data so that zooming in gives narrower buckets. */
export function bucketBounds(
  extent: SeriesExtent,
  xRange: MetricXRange | null,
): { lower: number; upper: number } | null {
  const lower = xRange?.min ?? extent.xMin;
  const upper = xRange?.max ?? extent.xMax;
  if (lower === null || upper === null) return null;
  return upper > lower ? { lower, upper } : { lower, upper: lower + SINGLE_VALUE_BUCKET_WIDTH };
}

/** A series of one Run is sampled only when it has more points than the chart can show. */
export function planSeriesBuckets(
  extent: SeriesExtent,
  options: { maxPoints: number; xRange: MetricXRange | null },
): BucketPlan | null {
  if (extent.totalPoints === 0) return null;
  if (extent.totalPoints <= options.maxPoints) return { kind: 'raw' };
  const bounds = bucketBounds(extent, options.xRange);
  return bounds && { kind: 'buckets', ...bounds, count: options.maxPoints };
}

/**
 * Runs of a group are always bucketed on bounds shared by every Run of the key, so a bucket means
 * the same x interval in each Run and in each group.
 */
export function planSharedBuckets(
  extent: SeriesExtent,
  options: { maxPoints: number; xRange: MetricXRange | null },
): Extract<BucketPlan, { kind: 'buckets' }> | null {
  if (extent.totalPoints === 0) return null;
  const bounds = bucketBounds(extent, options.xRange);
  return bounds && { kind: 'buckets', ...bounds, count: options.maxPoints };
}

/** Drops buckets that held only NaN or infinite values and totals those values. */
export function assembleSeriesPoints(rows: SeriesBucketRow[]): {
  points: MetricSeriesPoint[];
  nanCount: number;
} {
  const points: MetricSeriesPoint[] = [];
  let nanCount = 0;
  for (const row of rows) {
    nanCount += row.nanCount;
    if (row.count === 0) continue;
    points.push({
      x: row.x!,
      step: row.step!,
      value: row.value!,
      min: row.minValue!,
      max: row.maxValue!,
      count: row.count,
    });
  }
  return { points, nanCount };
}
