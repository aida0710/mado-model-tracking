import type { ChartLine } from '../../lib/metricSeries';
import { text } from '../../i18n/catalog';

/**
 * The series of a chart as buttons: a click hides or shows one, hovering highlights it in the plot.
 */
export function ChartLegend({
  lines,
  hiddenIds,
  onToggle,
  onHighlight,
  onShowAll,
}: {
  lines: readonly ChartLine[];
  hiddenIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onHighlight: (id: string | null) => void;
  onShowAll: () => void;
}) {
  return (
    <div className="chart-legend" role="group" aria-label={text.chartLegend}>
      {lines.map((line) => (
        <button
          key={line.id}
          type="button"
          className="chart-legend-item"
          title={line.label}
          aria-pressed={!hiddenIds.has(line.id)}
          onClick={() => onToggle(line.id)}
          onMouseEnter={() => onHighlight(line.id)}
          onMouseLeave={() => onHighlight(null)}
          onFocus={() => onHighlight(line.id)}
          onBlur={() => onHighlight(null)}
        >
          <span
            className={`chart-legend-swatch ${line.kind}`}
            style={{ background: line.color }}
            aria-hidden="true"
          />
          <span className="chart-legend-label">
            {line.label}
            {line.kind === 'group' && text.chartGroupSuffix}
          </span>
        </button>
      ))}
      {hiddenIds.size > 0 && (
        <button type="button" className="button small" onClick={onShowAll}>
          {text.chartShowAllSeries}
        </button>
      )}
    </div>
  );
}
