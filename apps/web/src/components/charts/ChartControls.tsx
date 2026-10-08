import { useId } from 'react';
import type { ChartSmoothing, ChartXAxis } from '@mmt/contracts';
import type { ChartDisplaySettings } from './chartProps';
import { text } from '../../i18n/catalog';

// The slider stops short of 1: EMA caps its weight at 0.999 and 1 would freeze the line.
const SMOOTHING_WEIGHT_MAX = 0.99;
const SMOOTHING_WEIGHT_STEP = 0.01;
// Weight a newly chosen smoothing starts at, so the change is visible right away.
const DEFAULT_SMOOTHING_WEIGHT = 0.6;

const smoothingLabels: Record<ChartSmoothing['kind'], string> = {
  none: text.chartSmoothingNone,
  ema: text.chartSmoothingEma,
  gaussian: text.chartSmoothingGaussian,
  running_average: text.chartSmoothingRunningAverage,
};
const xAxisLabels: Record<ChartXAxis['kind'], string> = {
  step: text.chartXAxisStep,
  relative_time: text.chartXAxisRelativeTime,
  wall_time: text.chartXAxisWallTime,
  metric: text.chartXAxisMetric,
};

const ALL_X_AXIS_KINDS = Object.keys(xAxisLabels) as ChartXAxis['kind'][];

/**
 * Smoothing, axes and range settings of one chart. The panel owns the settings; this only edits
 * them. `metricKeys` are the choices for a metric x axis; `xAxisKinds` limits the x axes offered.
 */
export function ChartControls({
  settings,
  metricKeys,
  xAxisKinds = ALL_X_AXIS_KINDS,
  onChange,
}: {
  settings: ChartDisplaySettings;
  metricKeys: readonly string[];
  xAxisKinds?: readonly ChartXAxis['kind'][];
  onChange: (settings: ChartDisplaySettings) => void;
}) {
  const idPrefix = useId();
  const { xAxis, smoothing } = settings;
  const change = (patch: Partial<ChartDisplaySettings>) => onChange({ ...settings, ...patch });

  function changeXAxisKind(kind: ChartXAxis['kind']) {
    const metricKey = xAxis.metricKey ?? metricKeys[0];
    change({
      xAxis: kind === 'metric' && metricKey ? { kind, metricKey } : { kind },
      // Log x is offered for steps only; time and metric axes go back to linear.
      xScale: kind === 'step' ? settings.xScale : 'linear',
    });
  }

  function changeSmoothingKind(kind: ChartSmoothing['kind']) {
    const weight = smoothing.weight > 0 ? smoothing.weight : DEFAULT_SMOOTHING_WEIGHT;
    change({ smoothing: { kind, weight: kind === 'none' ? smoothing.weight : weight } });
  }

  return (
    <div className="chart-controls">
      <div className="chart-control">
        <label htmlFor={`${idPrefix}-x-axis`}>{text.chartXAxis}</label>
        <select
          id={`${idPrefix}-x-axis`}
          value={xAxis.kind}
          onChange={(event) => changeXAxisKind(event.target.value as ChartXAxis['kind'])}
        >
          {xAxisKinds.map((kind) => (
            <option key={kind} value={kind} disabled={kind === 'metric' && metricKeys.length === 0}>
              {xAxisLabels[kind]}
            </option>
          ))}
        </select>
      </div>
      {xAxis.kind === 'metric' && (
        <div className="chart-control">
          <label htmlFor={`${idPrefix}-x-metric`}>{text.chartXAxisMetricKey}</label>
          <select
            id={`${idPrefix}-x-metric`}
            value={xAxis.metricKey ?? ''}
            onChange={(event) => change({ xAxis: { kind: 'metric', metricKey: event.target.value } })}
          >
            {metricKeys.map((key) => (
              <option key={key}>{key}</option>
            ))}
          </select>
        </div>
      )}
      <div className="chart-control">
        <label htmlFor={`${idPrefix}-smoothing`}>{text.chartSmoothing}</label>
        <select
          id={`${idPrefix}-smoothing`}
          value={smoothing.kind}
          onChange={(event) => changeSmoothingKind(event.target.value as ChartSmoothing['kind'])}
        >
          {Object.entries(smoothingLabels).map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {smoothing.kind !== 'none' && (
        <div className="chart-control chart-weight">
          <label htmlFor={`${idPrefix}-weight`}>{text.chartSmoothingWeight}</label>
          <input
            id={`${idPrefix}-weight`}
            type="range"
            min={0}
            max={SMOOTHING_WEIGHT_MAX}
            step={SMOOTHING_WEIGHT_STEP}
            value={Math.min(smoothing.weight, SMOOTHING_WEIGHT_MAX)}
            onChange={(event) =>
              change({ smoothing: { kind: smoothing.kind, weight: Number(event.target.value) } })
            }
          />
          <output className="mono">{smoothing.weight.toFixed(2)}</output>
        </div>
      )}
      <ChartToggle
        label={text.chartLogY}
        checked={settings.yScale === 'log'}
        onChange={(checked) => change({ yScale: checked ? 'log' : 'linear' })}
      />
      {xAxis.kind === 'step' && (
        <ChartToggle
          label={text.chartLogX}
          checked={settings.xScale === 'log'}
          onChange={(checked) => change({ xScale: checked ? 'log' : 'linear' })}
        />
      )}
      <ChartToggle
        label={text.chartShowRange}
        checked={settings.showRange}
        onChange={(checked) => change({ showRange: checked })}
      />
      {smoothing.kind !== 'none' && (
        <ChartToggle
          label={text.chartShowRaw}
          checked={settings.showRaw}
          onChange={(checked) => change({ showRaw: checked })}
        />
      )}
    </div>
  );
}

function ChartToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="checkbox-field chart-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}
