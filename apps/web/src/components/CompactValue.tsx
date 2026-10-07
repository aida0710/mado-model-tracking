import { formatCompactNumber, formatValue } from '../lib/format';

export function CompactValue({ value }: { value: unknown }) {
  return (
    <span className="compact-value" title={formatValue(value)}>
      {typeof value === 'number' ? formatCompactNumber(value) : formatValue(value)}
    </span>
  );
}
