// Time-axis math for the audio viewer: zooming, panning, pointer positions, and loop ranges.

export interface TimeRange {
  startSeconds: number;
  endSeconds: number;
}

// Below ~50ms a 1024-sample STFT frame at 16kHz (64ms) already covers the whole view.
export const MIN_VIEW_SECONDS = 0.05;
export const ZOOM_STEP = 2;

/** Keeps the span (when it fits) and shifts the range back inside [0, duration]. */
export function clampTimeRange(range: TimeRange, durationSeconds: number): TimeRange {
  const span = Math.min(durationSeconds, Math.max(0, range.endSeconds - range.startSeconds));
  const start = Math.min(Math.max(0, range.startSeconds), durationSeconds - span);
  return { startSeconds: start, endSeconds: start + span };
}

/**
 * Scales the span by 1/factor (factor > 1 zooms in) around `focusSeconds`, keeping the focus at the
 * same relative position. Returns null when the result covers the whole duration.
 */
export function zoomTimeRange(
  range: TimeRange,
  factor: number,
  focusSeconds: number,
  durationSeconds: number,
): TimeRange | null {
  const span = range.endSeconds - range.startSeconds;
  const nextSpan = Math.min(durationSeconds, Math.max(MIN_VIEW_SECONDS, span / factor));
  if (nextSpan >= durationSeconds) return null;
  const focus = Math.min(range.endSeconds, Math.max(range.startSeconds, focusSeconds));
  const ratio = span > 0 ? (focus - range.startSeconds) / span : 0.5;
  const start = focus - ratio * nextSpan;
  return clampTimeRange({ startSeconds: start, endSeconds: start + nextSpan }, durationSeconds);
}

export function timeAtFraction(fraction: number, range: TimeRange): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return range.startSeconds + clamped * (range.endSeconds - range.startSeconds);
}

/** Position of `seconds` in the range as 0..1; values outside the range fall outside 0..1. */
export function fractionOfTime(seconds: number, range: TimeRange): number {
  const span = range.endSeconds - range.startSeconds;
  return span > 0 ? (seconds - range.startSeconds) / span : 0;
}

export function loopRangeBetween(first: number, second: number): TimeRange {
  return { startSeconds: Math.min(first, second), endSeconds: Math.max(first, second) };
}

/** m:ss.cc, the precision needed to place a loop by ear. */
export function formatAudioTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalCentiseconds = Math.round(safe * 100);
  const minutes = Math.floor(totalCentiseconds / 6000);
  const remainder = (totalCentiseconds % 6000) / 100;
  return `${minutes}:${remainder.toFixed(2).padStart(5, '0')}`;
}
