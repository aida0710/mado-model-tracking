import { DEFAULT_BASELINE_ALIAS, type MetricValueStatus } from '@mmt/contracts';

// Prefers production, then the first alias by name. null lets the API apply its own default.
export function defaultBaselineAlias(aliases: Record<string, string>): string | null {
  if (Object.hasOwn(aliases, DEFAULT_BASELINE_ALIAS)) return DEFAULT_BASELINE_ALIAS;
  return Object.keys(aliases).sort()[0] ?? null;
}

const SIGNIFICANT_DIGITS = 6;
const RELATIVE_FRACTION_DIGITS = 2;

export function formatMetricValue(
  value: number | null,
  status: MetricValueStatus,
  labels: { notFinite: string },
): string {
  if (status === 'not_finite') return labels.notFinite;
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US', { maximumSignificantDigits: SIGNIFICANT_DIGITS }).format(
    value,
  );
}

// Differences always show their sign so that a decrease is not mistaken for a value.
export function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  return new Intl.NumberFormat('en-US', {
    maximumSignificantDigits: SIGNIFICANT_DIGITS,
    signDisplay: 'exceptZero',
  }).format(delta);
}

export function formatRelativeDelta(relativeDelta: number | null): string {
  if (relativeDelta === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: RELATIVE_FRACTION_DIGITS,
    signDisplay: 'exceptZero',
  }).format(relativeDelta);
}
