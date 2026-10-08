import type { MetricComparison, MetricValueSource, MetricValueStatus } from '@mmt/contracts';

// A metric value as read from storage. value may be NaN or ±Infinity; compareMetrics reports
// those as not_finite instead of computing differences from them.
export interface EvaluatedMetricValue {
  value: number;
  source: MetricValueSource;
}
export type EvaluatedMetrics = Readonly<Record<string, EvaluatedMetricValue>>;

interface MetricSide {
  value: number | null;
  status: MetricValueStatus;
  source: MetricValueSource | null;
}

function describeMetric(metric: EvaluatedMetricValue | undefined): MetricSide {
  if (!metric) return { value: null, status: 'missing', source: null };
  if (!Number.isFinite(metric.value))
    return { value: null, status: 'not_finite', source: metric.source };
  return { value: metric.value, status: 'present', source: metric.source };
}

/**
 * Lines up candidate and baseline metrics by key. Without metricKeys, every key logged on either
 * side is compared in name order. A side that is null (no evaluation Run) counts as missing.
 * Whether a larger value is better is not decided here; promotion policies define direction.
 */
export function compareMetrics(comparison: {
  candidate: EvaluatedMetrics | null;
  baseline: EvaluatedMetrics | null;
  metricKeys?: readonly string[];
}): MetricComparison[] {
  const candidate = comparison.candidate ?? {};
  const baseline = comparison.baseline ?? {};
  const keys =
    comparison.metricKeys ?? [...new Set([...Object.keys(candidate), ...Object.keys(baseline)])].sort();
  return keys.map((key) => {
    const candidateSide = describeMetric(Object.hasOwn(candidate, key) ? candidate[key] : undefined);
    const baselineSide = describeMetric(Object.hasOwn(baseline, key) ? baseline[key] : undefined);
    const delta =
      candidateSide.value !== null && baselineSide.value !== null
        ? candidateSide.value - baselineSide.value
        : null;
    // Dividing by |baseline| keeps the sign of delta, so a negative ratio always means "decreased".
    const relativeDelta =
      delta !== null && baselineSide.value !== 0 ? delta / Math.abs(baselineSide.value!) : null;
    return {
      key,
      candidate: candidateSide.value,
      baseline: baselineSide.value,
      candidateStatus: candidateSide.status,
      baselineStatus: baselineSide.status,
      delta,
      relativeDelta,
      source: { candidate: candidateSide.source, baseline: baselineSide.source },
    };
  });
}
