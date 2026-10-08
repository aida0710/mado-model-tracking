import { useState } from 'react';
import { MetricsChart as SampledMetricsChart } from './charts/MetricsChart';
import { ChartControls } from './charts/ChartControls';
import type { ChartDisplaySettings } from './charts/chartProps';
import { getMetricNames, recordedPointSeries, type MetricSeries } from '../lib/metricSeries';
import { Empty } from './Feedback';
import { text } from '../i18n/catalog';

const DEFAULT_DISPLAY_SETTINGS: ChartDisplaySettings = {
  xAxis: { kind: 'step' },
  xScale: 'linear',
  yScale: 'linear',
  smoothing: { kind: 'none', weight: 0 },
  showRange: true,
  showRaw: true,
};

/**
 * Transitional: the Run detail and compare pages still pass recorded points here. It draws them
 * with charts/MetricsChart on the step axis. Delete this file once chart-panels-and-pages-web moves
 * the pages to the chart panels.
 */
export function MetricsChart({ series }: { series: MetricSeries[] }) {
  const names = getMetricNames(series);
  const [selectedName, setSelectedName] = useState('');
  const [settings, setSettings] = useState(DEFAULT_DISPLAY_SETTINGS);
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
      <ChartControls
        settings={settings}
        metricKeys={[]}
        // Recorded points are drawn by step; the other x axes come with the chart panels.
        xAxisKinds={['step']}
        onChange={setSettings}
      />
      <SampledMetricsChart series={recordedPointSeries(series, metric)} {...settings} />
    </div>
  );
}
