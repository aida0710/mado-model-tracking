// Stub copy of metrics-chart-core-web's file (same wave); buildMetricRows stays until the old
// components/MetricsChart.tsx is removed by its owner.
import type {
  ChartXAxis,
  MetricGroup,
  MetricPoint,
  MetricSeries as SampledMetricSeries,
  RunResumeEventPage,
} from '@mmt/contracts';
import type {
  MetricsChartMarker,
  MetricsChartPoint,
  MetricsChartSeries,
} from '../components/charts/chartProps';

/** Every recorded point of a Run, as `GET /runs/:r/metrics` and the comparison history give them. */
export interface MetricSeries {
  id: string;
  label: string;
  points: MetricPoint[];
}

export const getMetricNames = (series: MetricSeries[]) =>
  Array.from(new Set(series.flatMap((item) => item.points.map((point) => point.name)))).sort();
export const isSystemMetric = (name: string) =>
  /^(system[./]|gpu[./]|cpu[./]|memory[./])/.test(name);

/** The id of a group series, kept apart from Run ids so the two never share a color or a key. */
export const groupSeriesId = (groupKey: string) => `group:${groupKey}`;

/**
 * One chart line per Run from recorded points on the step axis. Every point is drawn, ordered by
 * step and then by time; two values at the same step both stay instead of the later one winning.
 */
export function recordedPointSeries(series: MetricSeries[], metric: string): MetricsChartSeries[] {
  return series.map((item) => ({
    id: item.id,
    label: item.label,
    kind: 'run',
    points: item.points
      .filter((point) => point.name === metric)
      .sort(
        (left, right) => left.step - right.step || left.timestamp.localeCompare(right.timestamp),
      )
      .map((point) => ({ x: point.step, value: point.value })),
  }));
}

/**
 * One chart line per Run for `key` from `POST /metrics/series`. A sampled bucket keeps its min/max
 * as the band; a single stored point has none, so showRange draws no zero-width band for it.
 */
export function runChartSeries(
  series: readonly SampledMetricSeries[],
  key: string,
  runLabels: Readonly<Record<string, string>> = {},
): MetricsChartSeries[] {
  return series
    .filter((item) => item.key === key)
    .map((item) => ({
      id: item.runId,
      label: runLabels[item.runId] ?? item.runId,
      kind: 'run',
      points: item.points.map(
        (point): MetricsChartPoint =>
          point.min === point.max
            ? { x: point.x, value: point.value }
            : { x: point.x, value: point.value, min: point.min, max: point.max },
      ),
    }));
}

/** One mean line with its min/max band per group for `key` from `POST /metrics/groups`. */
export function groupChartSeries(
  groups: readonly MetricGroup[],
  key: string,
): MetricsChartSeries[] {
  return groups.map((group) => ({
    id: groupSeriesId(group.groupKey),
    label: group.label,
    kind: 'group',
    points: (group.series.find((item) => item.key === key)?.points ?? []).map((point) => ({
      x: point.x,
      value: point.mean,
      min: point.min,
      max: point.max,
    })),
  }));
}

/**
 * Where each later running segment of a Run starts on the x axis: the first step logged after the
 * resume on the step axis, the resume time on the time axes. The metric axis has no such position,
 * and a segment that logged no metric has no first step, so neither gets a marker.
 */
export function resumeMarkers(
  xAxis: ChartXAxis,
  runs: readonly { label: string; resumeEvents: RunResumeEventPage }[],
): MetricsChartMarker[] {
  return runs.flatMap(({ label, resumeEvents }) => {
    const runStartedAt = resumeEvents.segments[0]?.startedAt;
    return resumeEvents.segments.slice(1).flatMap((segment): MetricsChartMarker[] => {
      const x = markerX(xAxis, segment, runStartedAt);
      return x === null ? [] : [{ x, label }];
    });
  });
}

function markerX(
  xAxis: ChartXAxis,
  segment: RunResumeEventPage['segments'][number],
  runStartedAt: string | undefined,
): number | null {
  if (xAxis.kind === 'step') return segment.firstStep;
  if (xAxis.kind === 'wall_time') return Date.parse(segment.startedAt);
  if (xAxis.kind === 'relative_time' && runStartedAt)
    return (Date.parse(segment.startedAt) - Date.parse(runStartedAt)) / 1000;
  return null;
}

/**
 * The point of a line nearest to `x`, or null when `x` lies outside the line's x extent (the Run
 * had not reached it yet). Points are scanned in full because the metric x axis is not sorted.
 */
export function nearestPoint<T extends { x: number }>(points: readonly T[], x: number): T | null {
  let nearest: T | null = null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (!nearest || Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point;
  }
  return x < minX || x > maxX ? null : nearest;
}

export function buildMetricRows(
  series: MetricSeries[],
  metric: string,
): Array<Record<string, number>> {
  const byStep = new Map<number, Record<string, number>>();
  for (const item of series) {
    for (const point of [...item.points].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    )) {
      if (point.name !== metric) continue;
      const row = byStep.get(point.step) ?? { step: point.step };
      row[item.id] = point.value;
      byStep.set(point.step, row);
    }
  }
  return [...byStep.values()].sort((left, right) => (left.step ?? 0) - (right.step ?? 0));
}
