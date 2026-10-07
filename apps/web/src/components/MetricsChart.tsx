import { useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { buildMetricRows, getMetricNames, type MetricSeries } from '../lib/metricSeries';
import { formatNumber } from '../lib/format';
import { Empty } from './Feedback';
import { text } from '../i18n/catalog';

// Palette preserves the teal identity while keeping comparison splitLines distinguishable.
const SERIES_COLORS = ['#008c88', '#647ee5', '#cf9441', '#bd6ba0', '#3f9b59', '#8b71c7'];
export function MetricsChart({ series }: { series: MetricSeries[] }) {
  const names = getMetricNames(series);
  const [selectedName, setSelectedName] = useState('');
  const metric = names.includes(selectedName) ? selectedName : names[0];
  if (!metric) return <Empty>{text.noMetrics}</Empty>;
  return (
    <div className="metric-chart">
      <label className="chart-selector">
        <span>{text.metricName}</span>
        <select
          aria-label={text.metricName}
          value={metric}
          onChange={(event) => setSelectedName(event.target.value)}
        >
          {names.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <div className="chart-canvas" role="img" aria-label={`${text.metrics}: ${metric}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={buildMetricRows(series, metric)}
            margin={{ top: 16, right: 24, left: 16, bottom: 12 }}
            accessibilityLayer
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="step"
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fontSize: 11 }}
            />
            <YAxis
              tickFormatter={formatNumber}
              width={70}
              domain={['auto', 'auto']}
              tick={{ fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                fontFamily: 'var(--mono)',
              }}
            />
            <Legend />
            {series.map((item, index) => (
              <Line
                key={item.id}
                dataKey={item.id}
                name={item.label}
                type="linear"
                stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                dot={false}
                strokeWidth={2}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="chart-points">
        <summary>
          {text.metrics} · {text.details}
        </summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{text.runName}</th>
                <th>{text.step}</th>
                <th>{text.tagValue}</th>
              </tr>
            </thead>
            <tbody>
              {series.flatMap((item) =>
                item.points
                  .filter((point) => point.name === metric)
                  .map((point, index) => (
                    <tr key={`${item.id}-${index}`}>
                      <td>{item.label}</td>
                      <td className="mono">{point.step}</td>
                      <td className="mono">{formatNumber(point.value)}</td>
                    </tr>
                  )),
              )}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
