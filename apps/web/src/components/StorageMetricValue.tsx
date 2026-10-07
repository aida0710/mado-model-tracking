import type { PrometheusSample } from '../lib/prometheus';
import { formatBytes, formatCompactNumber } from '../lib/format';
import { text } from '../i18n/catalog';

export function StorageMetricValue({
  sample,
  unit = 'count',
}: {
  sample: PrometheusSample | undefined;
  unit?: 'bytes' | 'count' | 'seconds';
}) {
  if (!sample) return <span title={text.notMeasured}>—</span>;
  if (!Number.isFinite(sample.value) || sample.value < 0)
    return <span title={sample.rawValue}>—</span>;
  const suffix = unit === 'bytes' ? ' B' : unit === 'seconds' ? ` ${text.secondsUnit}` : '';
  return (
    <span title={sample.rawValue + suffix}>
      {unit === 'bytes'
        ? formatBytes(sample.value)
        : formatCompactNumber(sample.value) + (unit === 'seconds' ? suffix : '')}
    </span>
  );
}
