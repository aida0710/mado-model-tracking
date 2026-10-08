import { useState } from 'react';
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { text } from '../../i18n/catalog';
import { formatCompactNumber, formatNumber } from '../../lib/format';
import {
  canUseLogScale,
  createAxisScale,
  numericValue,
  rampColor,
  type AxisDefinition,
  type ChartRunRow,
} from '../../lib/parallelCoordinates';
import { useDocumentTheme } from '../../hooks/useDocumentTheme';
import { Empty } from '../Feedback';

export interface ParamScatterChartProps {
  rows: ChartRunRow[];
  /** Params and metrics that can be plotted; x and y take numeric ones. */
  fields: AxisDefinition[];
  defaultX?: string;
  defaultY?: string;
  defaultColor?: string;
  onRunClick?: (runId: string) => void;
  height?: number;
}

interface ScatterPoint {
  runId: string;
  name: string;
  x: number;
  y: number;
  color: string;
  colorValue: unknown;
}

const DEFAULT_HEIGHT = 380;
// Large enough to hit with a pointer while 5000 points still leave gaps between them.
const POINT_RADIUS = 4;
const AXIS_WIDTH = 72;
// Without a color field every point takes one mid step of the ramp.
const UNCOLORED_RAMP_POSITION = 0.6;

function FieldSelect({
  label,
  value,
  fields,
  allowNone,
  onChange,
}: {
  label: string;
  value: string;
  fields: AxisDefinition[];
  allowNone?: boolean;
  onChange: (key: string) => void;
}) {
  return (
    <label className="chart-selector">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {allowNone && <option value="">{text.analysisScatterNoColor}</option>}
        {fields.map((field) => (
          <option key={field.key} value={field.key}>
            {field.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Two params or metrics of every Run against each other, colored by a third value. */
export function ParamScatterChart({
  rows,
  fields,
  defaultX,
  defaultY,
  defaultColor,
  onRunClick,
  height = DEFAULT_HEIGHT,
}: ParamScatterChartProps) {
  const theme = useDocumentTheme();
  const numericFields = fields.filter((field) => field.kind === 'numeric');
  const pick = (preferred: string | undefined, fallbackIndex: number) =>
    preferred && numericFields.some((field) => field.key === preferred)
      ? preferred
      : (numericFields[fallbackIndex] ?? numericFields[0])?.key ?? '';
  const [xKey, setXKey] = useState(() => pick(defaultX, 0));
  const [yKey, setYKey] = useState(() => pick(defaultY, 1));
  const [colorKey, setColorKey] = useState(defaultColor ?? '');
  const [logAxes, setLogAxes] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });

  const x = numericFields.some((field) => field.key === xKey) ? xKey : pick(undefined, 0);
  const y = numericFields.some((field) => field.key === yKey) ? yKey : pick(undefined, 1);
  if (!x || !y) return <Empty>{text.analysisScatterNoPoints}</Empty>;

  const xValues = rows.map((row) => row.values[x]);
  const yValues = rows.map((row) => row.values[y]);
  const logAvailable = { x: canUseLogScale(xValues), y: canUseLogScale(yValues) };
  const useLog = { x: logAxes.x && logAvailable.x, y: logAxes.y && logAvailable.y };
  const colorField = fields.find((field) => field.key === colorKey);
  const colorScale = colorField
    ? createAxisScale(colorField, rows.map((row) => row.values[colorField.key]), { log: false })
    : null;
  const points: ScatterPoint[] = rows.flatMap((row) => {
    const pointX = numericValue(row.values[x]);
    const pointY = numericValue(row.values[y]);
    if (pointX === null || pointY === null) return [];
    if ((useLog.x && pointX <= 0) || (useLog.y && pointY <= 0)) return [];
    const colorValue = colorField ? row.values[colorField.key] : undefined;
    const color = colorScale ? rampColor(colorScale.position(colorValue), theme) : rampColor(UNCOLORED_RAMP_POSITION, theme);
    return [{ runId: row.runId, name: row.name, x: pointX, y: pointY, color, colorValue }];
  });
  const labelOf = (key: string) => fields.find((field) => field.key === key)?.label ?? key;

  return (
    <div className="scatter-chart">
      <div className="scatter-chart-controls">
        <FieldSelect label={text.analysisScatterX} value={x} fields={numericFields} onChange={setXKey} />
        {logAvailable.x && (
          <label className="parallel-axis-log">
            <input
              type="checkbox"
              checked={logAxes.x}
              aria-label={`${text.analysisScatterX}: ${text.analysisLogScale}`}
              onChange={(event) => setLogAxes((current) => ({ ...current, x: event.target.checked }))}
            />
            {text.analysisLogScale}
          </label>
        )}
        <FieldSelect label={text.analysisScatterY} value={y} fields={numericFields} onChange={setYKey} />
        {logAvailable.y && (
          <label className="parallel-axis-log">
            <input
              type="checkbox"
              checked={logAxes.y}
              aria-label={`${text.analysisScatterY}: ${text.analysisLogScale}`}
              onChange={(event) => setLogAxes((current) => ({ ...current, y: event.target.checked }))}
            />
            {text.analysisLogScale}
          </label>
        )}
        <FieldSelect label={text.analysisScatterColor} value={colorKey} fields={fields} allowNone onChange={setColorKey} />
        <span className="parallel-chart-hint">{text.analysisScatterHint}</span>
      </div>
      {points.length === 0 ? (
        <Empty>{text.analysisScatterNoPoints}</Empty>
      ) : (
        <div className="scatter-chart-canvas" style={{ height }} role="img" aria-label={`${labelOf(x)} × ${labelOf(y)}`}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 12, right: 24, bottom: 24, left: 12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                type="number"
                dataKey="x"
                name={labelOf(x)}
                scale={useLog.x ? 'log' : 'linear'}
                domain={['auto', 'auto']}
                tickFormatter={formatCompactNumber}
                tick={{ fontSize: 11 }}
                label={{ value: labelOf(x), position: 'insideBottom', offset: -12, fontSize: 12 }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name={labelOf(y)}
                scale={useLog.y ? 'log' : 'linear'}
                domain={['auto', 'auto']}
                tickFormatter={formatCompactNumber}
                tick={{ fontSize: 11 }}
                width={AXIS_WIDTH}
                label={{ value: labelOf(y), angle: -90, position: 'insideLeft', fontSize: 12 }}
              />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  const point = active ? (payload?.[0]?.payload as ScatterPoint | undefined) : undefined;
                  if (!point) return null;
                  return (
                    <div className="scatter-tooltip">
                      <strong>{point.name}</strong>
                      <span>{`${labelOf(x)}: ${formatNumber(point.x)}`}</span>
                      <span>{`${labelOf(y)}: ${formatNumber(point.y)}`}</span>
                      {colorField && <span>{`${colorField.label}: ${String(point.colorValue ?? '—')}`}</span>}
                    </div>
                  );
                }}
              />
              <Scatter
                data={points}
                isAnimationActive={false}
                shape={(props: { cx?: number; cy?: number; payload?: ScatterPoint }) => {
                  const point = props.payload;
                  if (props.cx === undefined || props.cy === undefined || !point) return <g />;
                  return (
                    <circle
                      cx={props.cx}
                      cy={props.cy}
                      r={POINT_RADIUS}
                      fill={point.color}
                      className="scatter-point"
                      data-run-id={point.runId}
                      onClick={() => onRunClick?.(point.runId)}
                    />
                  );
                }}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
