import type { ChartXAxis } from '@mmt/contracts';
import { formatNumber } from './format';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
// Steps up to this many digits read well in full; longer ones use the compact 1.2M form.
const FULL_STEP_TICK_LIMIT = 100_000;

const compactStepFormat = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumSignificantDigits: 4,
});

/** Tick text for an x value: an integer step, an elapsed time like 1h23m, or a local date-time. */
export function formatXTick(xAxis: ChartXAxis, value: number): string {
  if (xAxis.kind === 'step') {
    const step = Math.round(value);
    return Math.abs(step) < FULL_STEP_TICK_LIMIT ? String(step) : compactStepFormat.format(step);
  }
  if (xAxis.kind === 'relative_time') return formatElapsedSeconds(value);
  if (xAxis.kind === 'wall_time') return formatWallTime(value, false);
  return formatNumber(value);
}

/** Text for an x value in the tooltip, more precise than a tick. */
export function formatXValue(xAxis: ChartXAxis, value: number): string {
  if (xAxis.kind === 'step') return String(Math.round(value));
  if (xAxis.kind === 'relative_time') return formatElapsedSeconds(value);
  if (xAxis.kind === 'wall_time') return formatWallTime(value, true);
  return formatNumber(value);
}

/**
 * Seconds as the two largest units: 45s, 4m05s, 1h23m, 2d03h. Sampled buckets carry a mean x, so
 * the value is rounded to whole seconds first.
 */
export function formatElapsedSeconds(value: number): string {
  const sign = value < 0 ? '-' : '';
  const seconds = Math.round(Math.abs(value));
  if (seconds < SECONDS_PER_MINUTE) return `${sign}${seconds}s`;
  const [largeUnit, smallUnit, largeSuffix, smallSuffix] =
    seconds < SECONDS_PER_HOUR
      ? [SECONDS_PER_MINUTE, 1, 'm', 's']
      : seconds < SECONDS_PER_DAY
        ? [SECONDS_PER_HOUR, SECONDS_PER_MINUTE, 'h', 'm']
        : [SECONDS_PER_DAY, SECONDS_PER_HOUR, 'd', 'h'];
  const large = Math.floor(seconds / largeUnit);
  const small = Math.floor((seconds % largeUnit) / smallUnit);
  return `${sign}${large}${largeSuffix}${padTwoDigits(small)}${smallSuffix}`;
}

/** Epoch milliseconds in local time: `10/08 13:45` on ticks, `2026/10/08 13:45:07` in the tooltip. */
export function formatWallTime(epochMilliseconds: number, withSeconds: boolean): string {
  const date = new Date(epochMilliseconds);
  const monthDay = `${padTwoDigits(date.getMonth() + 1)}/${padTwoDigits(date.getDate())}`;
  const hourMinute = `${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}`;
  return withSeconds
    ? `${date.getFullYear()}/${monthDay} ${hourMinute}:${padTwoDigits(date.getSeconds())}`
    : `${monthDay} ${hourMinute}`;
}

const padTwoDigits = (part: number) => String(part).padStart(2, '0');
