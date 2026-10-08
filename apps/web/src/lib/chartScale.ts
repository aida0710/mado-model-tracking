import type { MetricsChartPoint } from '../components/charts/chartProps';

export type ChartScale = 'linear' | 'log';

// Room above and below the lines so the extremes do not touch the frame.
const LINEAR_DOMAIN_PADDING_RATIO = 0.05;
// On a log axis the same room is a factor: about 5% of a decade on each side.
const LOG_DOMAIN_PADDING_FACTOR = 10 ** 0.05;

export interface PlottablePoints {
  points: MetricsChartPoint[];
  /** Points left out because a log axis cannot place a value at or below 0. */
  excludedCount: number;
}

/**
 * Keeps the points a log axis can place. A point whose x (log x) or value (log y) is at or below 0
 * is left out and counted rather than moved to a made-up value; a band whose lower edge is at or
 * below 0 is dropped for that point while its line value stays.
 */
export function keepPlottablePoints(
  points: readonly MetricsChartPoint[],
  scales: { xScale: ChartScale; yScale: ChartScale },
): PlottablePoints {
  if (scales.xScale === 'linear' && scales.yScale === 'linear')
    return { points: [...points], excludedCount: 0 };
  const kept: MetricsChartPoint[] = [];
  let excludedCount = 0;
  for (const point of points) {
    if ((scales.xScale === 'log' && point.x <= 0) || (scales.yScale === 'log' && point.value <= 0)) {
      excludedCount += 1;
      continue;
    }
    const isBandPlottable =
      scales.yScale === 'linear' || point.min === undefined || point.min > 0;
    kept.push(isBandPlottable ? point : { x: point.x, value: point.value });
  }
  return { points: kept, excludedCount };
}

/**
 * The [min, max] the y axis shows for the given values, padded so lines do not touch the frame.
 * Non-finite values (and values at or below 0 on a log axis) are ignored; null when none remain.
 */
export function paddedDomain(values: Iterable<number>, scale: ChartScale): [number, number] | null {
  const extent = plottableExtent(values, scale);
  if (!extent) return null;
  const [min, max] = extent;
  if (scale === 'log') return [min / LOG_DOMAIN_PADDING_FACTOR, max * LOG_DOMAIN_PADDING_FACTOR];
  // A flat line still needs a visible span around it.
  const padding =
    max === min
      ? Math.abs(min) * LINEAR_DOMAIN_PADDING_RATIO || 1
      : (max - min) * LINEAR_DOMAIN_PADDING_RATIO;
  return [min - padding, max + padding];
}

/** The [min, max] of the x values, unpadded so the lines start and end at the frame. */
export function xExtent(values: Iterable<number>, scale: ChartScale): [number, number] | null {
  const extent = plottableExtent(values, scale);
  if (!extent) return null;
  const [min, max] = extent;
  if (min < max) return extent;
  // A single x still needs a span to draw on.
  return scale === 'log' ? [min / 10, min * 10] : [min - 1, max + 1];
}

function plottableExtent(values: Iterable<number>, scale: ChartScale): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value) || (scale === 'log' && value <= 0)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min > max ? null : [min, max];
}

/** Maps a data value to a pixel; undefined when the axis cannot place it. */
export type PixelScale = (value: number) => number | undefined;

/**
 * SVG path of a line through (x, value) pairs. A value the axes cannot place (NaN) ends the
 * current piece, so a gap shows as a gap instead of a straight line across it.
 */
export function linePath(
  xs: readonly number[],
  values: readonly number[],
  scales: { x: PixelScale; y: PixelScale },
): string {
  let path = '';
  let isPieceOpen = false;
  xs.forEach((x, index) => {
    const pixelX = scales.x(x);
    const pixelY = Number.isFinite(values[index]) ? scales.y(values[index]!) : undefined;
    if (!isPixel(pixelX) || !isPixel(pixelY)) {
      isPieceOpen = false;
      return;
    }
    path += `${isPieceOpen ? 'L' : 'M'}${pixelX.toFixed(1)},${pixelY.toFixed(1)}`;
    isPieceOpen = true;
  });
  return path;
}

/**
 * SVG path of the min-max band: closed shapes along the upper edge and back along the lower one.
 * A point without a band ends the current shape.
 */
export function bandPath(
  points: readonly MetricsChartPoint[],
  scales: { x: PixelScale; y: PixelScale },
): string {
  let path = '';
  let piece: { x: number; top: number; bottom: number }[] = [];
  const closePiece = () => {
    if (piece.length > 1) {
      const upper = piece.map((corner) => `${corner.x.toFixed(1)},${corner.top.toFixed(1)}`);
      const lower = piece.map((corner) => `${corner.x.toFixed(1)},${corner.bottom.toFixed(1)}`);
      path += `M${upper.join('L')}L${lower.reverse().join('L')}Z`;
    }
    piece = [];
  };
  for (const point of points) {
    const x = scales.x(point.x);
    const top = point.max === undefined ? undefined : scales.y(point.max);
    const bottom = point.min === undefined ? undefined : scales.y(point.min);
    if (isPixel(x) && isPixel(top) && isPixel(bottom)) piece.push({ x, top, bottom });
    else closePiece();
  }
  closePiece();
  return path;
}

const isPixel = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);
