import { formatNumber } from '../../lib/format';
import type { ChartValueAtX } from '../../lib/metricSeries';
import { textTemplates } from '../../i18n/catalog';

/**
 * The values of the series at the hovered x. The chart passes the rows already ordered and cut to
 * the ones that fit; `hiddenRowCount` says how many more series have a value there.
 */
export function ChartTooltip({
  xText,
  rows,
  hiddenRowCount,
  position,
}: {
  xText: string;
  rows: readonly ChartValueAtX[];
  hiddenRowCount: number;
  /** Pixels from the top-left of the chart; `alignRight` puts the box left of the pointer. */
  position: { left: number; top: number; alignRight: boolean };
}) {
  return (
    <div
      className="chart-tooltip"
      role="status"
      style={{
        left: position.left,
        top: position.top,
        transform: position.alignRight ? 'translateX(-100%)' : undefined,
      }}
    >
      <div className="chart-tooltip-x mono">{xText}</div>
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <span className="chart-legend-swatch" style={{ background: row.color }} />
              </td>
              <td className="chart-tooltip-label">{row.label}</td>
              <td className="mono">{formatNumber(row.value)}</td>
              {row.rawValue !== undefined && (
                <td className="mono chart-tooltip-raw">{formatNumber(row.rawValue)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {hiddenRowCount > 0 && (
        <div className="chart-tooltip-more">{textTemplates.chartTooltipMore(hiddenRowCount)}</div>
      )}
    </div>
  );
}
