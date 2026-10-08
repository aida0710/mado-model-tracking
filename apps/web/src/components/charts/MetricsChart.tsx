// Stub of metrics-chart-core-web's chart (same wave). It draws the props of chartProps.ts plainly
// so the panels can be checked in this worktree; the owner's implementation replaces this file.
// The class names match the owner's chart so tests/browser-charts.mjs passes on both.
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricsChartProps } from './chartProps';
import { seriesColor } from '../../lib/seriesColors';
import { formatNumber } from '../../lib/format';
import { Empty } from '../Feedback';
import { text, textTemplates } from '../../i18n/catalog';

const STUB_CHART_HEIGHT_PX = 240;

export function MetricsChart({ series, yScale, showRange, markers = [], height }: MetricsChartProps) {
  const drawn = series.filter((item) => item.points.length);
  if (!drawn.length) return <Empty>{text.chartNoData}</Empty>;
  const rows = new Map<number, Record<string, number | [number, number]>>();
  for (const item of drawn)
    for (const point of item.points) {
      if (yScale === 'log' && point.value <= 0) continue;
      const row = rows.get(point.x) ?? { x: point.x };
      row[item.id] = point.value;
      if (point.min !== undefined && point.max !== undefined)
        row[`${item.id}:range`] = [point.min, point.max];
      rows.set(point.x, row);
    }
  const data = [...rows.values()].sort((left, right) => (left.x as number) - (right.x as number));
  return (
    <div
      className="metrics-chart"
      role="img"
      aria-label={textTemplates.chartAriaLabel(drawn.length)}
      style={{ height: height ?? STUB_CHART_HEIGHT_PX }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 11 }} />
          <YAxis
            scale={yScale === 'log' ? 'log' : 'auto'}
            domain={['auto', 'auto']}
            tickFormatter={formatNumber}
            width={64}
            tick={{ fontSize: 11 }}
          />
          <Tooltip />
          {showRange &&
            drawn.map((item) => (
              <Area
                key={`${item.id}:range`}
                className="chart-band"
                dataKey={`${item.id}:range`}
                stroke="none"
                fill={item.color ?? seriesColor(item.id)}
                fillOpacity={0.15}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          {drawn.map((item) => (
            <Line
              key={item.id}
              className="chart-line"
              dataKey={item.id}
              name={item.label}
              stroke={item.color ?? seriesColor(item.id)}
              dot={false}
              strokeWidth={item.kind === 'group' ? 2.5 : 1.5}
              isAnimationActive={false}
              connectNulls
            />
          ))}
          {markers.map((marker) => (
            <ReferenceLine
              key={`${marker.label}:${marker.x}`}
              className="chart-marker"
              x={marker.x}
              stroke="var(--warning, #cf9441)"
              strokeDasharray="4 3"
              label={{ value: marker.label, fontSize: 10, position: 'top' }}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
