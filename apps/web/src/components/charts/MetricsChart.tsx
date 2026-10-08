import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatNumber } from '../../lib/format';
import type { MetricsChartProps } from './chartProps';

// Stub for this worktree (sweeps-web): metrics-chart-core-web owns MetricsChart and its version
// wins at integration. It draws each series as a plain line so the sweep page can be checked.
const SERIES_COLORS = ['#008c88', '#647ee5', '#cf9441', '#bd6ba0', '#3f9b59', '#8b71c7'];
const DEFAULT_HEIGHT = 280;

export function MetricsChart({ series, height = DEFAULT_HEIGHT }: MetricsChartProps) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart margin={{ top: 12, right: 24, left: 12, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={formatNumber} width={70} domain={['auto', 'auto']} tick={{ fontSize: 11 }} />
          <Tooltip />
          {series.map((item, index) => (
            <Line key={item.id} data={item.points} dataKey="value" name={item.label} dot={false}
              stroke={item.color ?? SERIES_COLORS[index % SERIES_COLORS.length]} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
