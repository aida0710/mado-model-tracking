import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { text, textTemplates } from '../../i18n/catalog';
import {
  canUseLogScale,
  computePositions,
  createAxisScale,
  moveAxis,
  rampColor,
  rampStops,
  selectRowIndexes,
  type AxisBrush,
  type AxisDefinition,
  type AxisScale,
  type ChartRunRow,
} from '../../lib/parallelCoordinates';
import { useDocumentTheme } from '../../hooks/useDocumentTheme';
import { useElementWidth } from '../../hooks/useElementWidth';

export interface ParallelCoordinatesChartProps {
  rows: ChartRunRow[];
  axes: AxisDefinition[];
  /** The axis whose value colors the lines (the target metric); null draws one color. */
  colorAxisKey: string | null;
  /** Called with the Run IDs inside every brush once a drag ends (all Runs when none). */
  onSelectionChange?: (runIds: string[]) => void;
  height?: number;
}

// SVG paths stay interactive up to a few hundred lines; beyond that the lines go to one canvas so
// 5000 Runs still redraw within a frame while brushing.
export const PARALLEL_LINES_CANVAS_THRESHOLD = 500;
const DEFAULT_HEIGHT = 380;
const MARGIN_LEFT = 48;
const MARGIN_RIGHT = 72;
// Room for the HTML axis headers above the plot and the missing band below it.
const PLOT_TOP = 76;
const PLOT_BOTTOM_GAP = 60;
const MISSING_BAND_GAP = 28;
const AXIS_HIT_WIDTH = 28;
// Tick labels are 10px monospace (styles/analysis.css): about 0.6em per character. The plate
// behind a label hides the Run lines that cross it, which a text halo alone did not.
const TICK_CHARACTER_WIDTH = 6;
const TICK_LABEL_OFFSET = 5;
const TICK_PLATE_HEIGHT = 12;
const TICK_PLATE_PADDING = 2;
// A press without this much travel (as a share of the axis) is a click that clears the brush.
const CLICK_TRAVEL = 0.01;
const UNSELECTED_LINE_COLOR = 'rgba(128, 128, 128, 0.14)';
// Thousands of overlapping canvas lines add up, so each one is fainter than an SVG line.
const UNSELECTED_CANVAS_LINE_COLOR = 'rgba(128, 128, 128, 0.05)';

interface ChartLayout {
  width: number;
  height: number;
  plotTop: number;
  plotBottom: number;
  missingY: number;
  axisX: (index: number) => number;
}

function createLayout(width: number, height: number, axisCount: number): ChartLayout {
  const plotBottom = height - PLOT_BOTTOM_GAP;
  const span = Math.max(0, width - MARGIN_LEFT - MARGIN_RIGHT);
  return {
    width,
    height,
    plotTop: PLOT_TOP,
    plotBottom,
    missingY: height - MISSING_BAND_GAP,
    axisX: (index) => (axisCount <= 1 ? MARGIN_LEFT + span / 2 : MARGIN_LEFT + (span * index) / (axisCount - 1)),
  };
}

function yOf(layout: ChartLayout, position: number | null): number {
  return position === null ? layout.missingY : layout.plotBottom - position * (layout.plotBottom - layout.plotTop);
}

/** Axis order kept by key: removed axes drop out and newly shown ones are appended. */
function orderAxes(axes: AxisDefinition[], order: string[]): AxisDefinition[] {
  const byKey = new Map(axes.map((axis) => [axis.key, axis]));
  const kept = order.flatMap((key) => byKey.get(key) ?? []);
  const keptKeys = new Set(kept.map((axis) => axis.key));
  return [...kept, ...axes.filter((axis) => !keptKeys.has(axis.key))];
}

export function ParallelCoordinatesChart({
  rows,
  axes,
  colorAxisKey,
  onSelectionChange,
  height = DEFAULT_HEIGHT,
}: ParallelCoordinatesChartProps) {
  const theme = useDocumentTheme();
  const { ref: containerRef, width } = useElementWidth();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [axisOrder, setAxisOrder] = useState<string[]>([]);
  const [logAxes, setLogAxes] = useState<ReadonlySet<string>>(new Set());
  const [brushes, setBrushes] = useState<AxisBrush[]>([]);
  const [draggingBrush, setDraggingBrush] = useState<AxisBrush | null>(null);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  const orderedAxes = useMemo(() => orderAxes(axes, axisOrder), [axes, axisOrder]);
  const scaledAxes = useMemo(
    () =>
      orderedAxes.map((axis) => {
        const values = rows.map((row) => row.values[axis.key]);
        return {
          definition: axis,
          key: axis.key,
          logAvailable: axis.kind === 'numeric' && canUseLogScale(values),
          scale: createAxisScale(axis, values, { log: logAxes.has(axis.key) }),
        };
      }),
    [orderedAxes, rows, logAxes],
  );
  const positions = useMemo(() => computePositions(rows, scaledAxes), [rows, scaledAxes]);
  const colorPositions = useMemo(() => {
    if (!colorAxisKey) return null;
    const shown = positions.get(colorAxisKey);
    if (shown) return shown;
    const definition = axes.find((axis) => axis.key === colorAxisKey) ?? {
      key: colorAxisKey,
      label: colorAxisKey,
      kind: 'numeric' as const,
    };
    const scale = createAxisScale(definition, rows.map((row) => row.values[colorAxisKey]), { log: false });
    return rows.map((row) => scale.position(row.values[colorAxisKey]));
  }, [axes, colorAxisKey, positions, rows]);

  const activeBrushes = useMemo(
    () => (draggingBrush ? [...brushes.filter((brush) => brush.axisKey !== draggingBrush.axisKey), draggingBrush] : brushes),
    [brushes, draggingBrush],
  );
  const selectedIndexes = useMemo(
    () => selectRowIndexes(rows.length, positions, activeBrushes),
    [rows.length, positions, activeBrushes],
  );
  const selectedFlags = useMemo(() => {
    const flags = new Uint8Array(rows.length);
    for (const index of selectedIndexes) flags[index] = 1;
    return flags;
  }, [rows.length, selectedIndexes]);

  // Reported only for committed brushes so a drag does not re-render the page on every move.
  const committedSelection = useMemo(
    () => selectRowIndexes(rows.length, positions, brushes).map((index) => rows[index]!.runId),
    [rows, positions, brushes],
  );
  useEffect(() => {
    onSelectionChangeRef.current?.(committedSelection);
  }, [committedSelection]);

  const layout = createLayout(width, height, scaledAxes.length);
  const usesCanvas = rows.length > PARALLEL_LINES_CANVAS_THRESHOLD;
  const lineColor = (index: number) =>
    selectedFlags[index] ? rampColor(colorPositions?.[index] ?? null, theme) : UNSELECTED_LINE_COLOR;
  const linePoints = (index: number) =>
    scaledAxes.map((axis, axisIndex) => [layout.axisX(axisIndex), yOf(layout, positions.get(axis.key)?.[index] ?? null)] as const);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!usesCanvas || !canvas || width === 0) return;
    const frame = requestAnimationFrame(() => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.lineWidth = 1;
      // One path per color: a few stroke calls instead of one per Run keeps 5000 lines in a frame.
      const unselected: number[] = [];
      const selectedByColor = new Map<string, number[]>();
      for (let index = 0; index < rows.length; index += 1) {
        if (!selectedFlags[index]) {
          unselected.push(index);
          continue;
        }
        const color = lineColor(index);
        const bucket = selectedByColor.get(color);
        if (bucket) bucket.push(index);
        else selectedByColor.set(color, [index]);
      }
      // Unselected lines first so the selected ones stay on top.
      for (const [color, indexes] of [[UNSELECTED_CANVAS_LINE_COLOR, unselected] as const, ...selectedByColor]) {
        context.strokeStyle = color;
        context.beginPath();
        for (const index of indexes)
          linePoints(index).forEach(([x, y], pointIndex) => (pointIndex === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
        context.stroke();
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  function positionAt(event: ReactPointerEvent<SVGRectElement>): number {
    const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const y = event.clientY - bounds.top;
    const position = (layout.plotBottom - y) / (layout.plotBottom - layout.plotTop);
    return Math.min(1, Math.max(0, position));
  }

  function startBrush(axisKey: string, event: ReactPointerEvent<SVGRectElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const position = positionAt(event);
    setDraggingBrush({ axisKey, from: position, to: position });
  }

  function moveBrush(event: ReactPointerEvent<SVGRectElement>) {
    if (!draggingBrush) return;
    const position = positionAt(event);
    setDraggingBrush((current) => (current ? { ...current, to: position } : current));
  }

  function endBrush() {
    if (!draggingBrush) return;
    const isClick = Math.abs(draggingBrush.to - draggingBrush.from) < CLICK_TRAVEL;
    setBrushes((current) => [
      ...current.filter((brush) => brush.axisKey !== draggingBrush.axisKey),
      ...(isClick ? [] : [draggingBrush]),
    ]);
    setDraggingBrush(null);
  }

  function toggleLog(axisKey: string) {
    setLogAxes((current) => {
      const next = new Set(current);
      if (!next.delete(axisKey)) next.add(axisKey);
      return next;
    });
    // A brush is a range of positions, which mean different values on the other scale.
    setBrushes((current) => current.filter((brush) => brush.axisKey !== axisKey));
  }

  const axisSpacing = scaledAxes.length > 1 ? layout.axisX(1) - layout.axisX(0) : width;
  return (
    <div className="parallel-chart">
      <div className="parallel-chart-toolbar">
        <span className="parallel-chart-count" data-testid="parallel-selection-count">
          {textTemplates.analysisSelectionCount(selectedIndexes.length, rows.length)}
        </span>
        <button type="button" className="button small" disabled={brushes.length === 0} onClick={() => setBrushes([])}>
          {text.analysisClearBrushes}
        </button>
        <span className="parallel-chart-hint">{text.analysisBrushHint}</span>
        {colorAxisKey && <ColorLegend theme={theme} />}
      </div>
      <div className="parallel-chart-plot" ref={containerRef} style={{ height }}>
        {usesCanvas && <canvas ref={canvasRef} className="parallel-chart-canvas" style={{ width, height }} />}
        {width > 0 && (
          <svg width={width} height={height} className="parallel-chart-svg" role="img" aria-label={text.analysisParallel}>
            {!usesCanvas &&
              rows.map((row, index) => (
                <path
                  key={row.runId}
                  d={linePoints(index)
                    .map(([x, y], pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
                    .join('')}
                  stroke={lineColor(index)}
                  className={selectedFlags[index] ? 'parallel-line selected' : 'parallel-line'}
                >
                  <title>{row.name}</title>
                </path>
              ))}
            <line
              x1={MARGIN_LEFT / 2}
              x2={width - MARGIN_RIGHT / 2}
              y1={layout.missingY - MISSING_BAND_GAP / 2}
              y2={layout.missingY - MISSING_BAND_GAP / 2}
              className="parallel-missing-divider"
            />
            <text x={4} y={layout.missingY + 4} className="parallel-missing-label">
              {text.analysisMissing}
            </text>
            {scaledAxes.map((axis, axisIndex) => (
              <AxisGraphic
                key={axis.key}
                axisKey={axis.key}
                label={axis.definition.label}
                scale={axis.scale}
                x={layout.axisX(axisIndex)}
                layout={layout}
                brush={activeBrushes.find((brush) => brush.axisKey === axis.key) ?? null}
                onPointerDown={(event) => startBrush(axis.key, event)}
                onPointerMove={moveBrush}
                onPointerUp={endBrush}
              />
            ))}
          </svg>
        )}
        {scaledAxes.map((axis, axisIndex) => (
          <div
            key={axis.key}
            className="parallel-axis-header"
            style={{ left: layout.axisX(axisIndex), width: Math.max(60, axisSpacing - 8) }}
          >
            <span className="parallel-axis-label" title={axis.definition.label}>
              {axis.definition.label}
            </span>
            <span className="parallel-axis-actions">
              <button
                type="button"
                className="icon-button"
                aria-label={`${axis.definition.label}: ${text.analysisMoveAxisLeft}`}
                title={text.analysisMoveAxisLeft}
                disabled={axisIndex === 0}
                onClick={() => setAxisOrder(moveAxis(orderedAxes.map((item) => item.key), axis.key, -1))}
              >
                <ArrowLeft size={12} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`${axis.definition.label}: ${text.analysisMoveAxisRight}`}
                title={text.analysisMoveAxisRight}
                disabled={axisIndex === scaledAxes.length - 1}
                onClick={() => setAxisOrder(moveAxis(orderedAxes.map((item) => item.key), axis.key, 1))}
              >
                <ArrowRight size={12} />
              </button>
              {axis.logAvailable && (
                <label className="parallel-axis-log">
                  <input
                    type="checkbox"
                    checked={logAxes.has(axis.key)}
                    aria-label={`${axis.definition.label}: ${text.analysisLogScale}`}
                    onChange={() => toggleLog(axis.key)}
                  />
                  {text.analysisLogScale}
                </label>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AxisGraphic({
  axisKey,
  label,
  scale,
  x,
  layout,
  brush,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  axisKey: string;
  label: string;
  scale: AxisScale;
  x: number;
  layout: ChartLayout;
  brush: AxisBrush | null;
  onPointerDown: (event: ReactPointerEvent<SVGRectElement>) => void;
  onPointerMove: (event: ReactPointerEvent<SVGRectElement>) => void;
  onPointerUp: () => void;
}) {
  const brushTop = brush ? yOf(layout, Math.max(brush.from, brush.to)) : 0;
  const brushBottom = brush ? yOf(layout, Math.min(brush.from, brush.to)) : 0;
  return (
    <g className="parallel-axis" data-axis-key={axisKey}>
      <line x1={x} x2={x} y1={layout.plotTop} y2={layout.plotBottom} className="parallel-axis-line" />
      <circle cx={x} cy={layout.missingY} r={3} className="parallel-missing-marker" />
      {scale.ticks.map((tick) => (
        <g key={`${tick.position}:${tick.label}`}>
          <line x1={x - 3} x2={x} y1={yOf(layout, tick.position)} y2={yOf(layout, tick.position)} className="parallel-axis-line" />
          <rect
            x={x + TICK_LABEL_OFFSET - TICK_PLATE_PADDING}
            y={yOf(layout, tick.position) - TICK_PLATE_HEIGHT / 2}
            width={tick.label.length * TICK_CHARACTER_WIDTH + TICK_PLATE_PADDING * 2}
            height={TICK_PLATE_HEIGHT}
            className="parallel-axis-tick-plate"
          />
          <text x={x + TICK_LABEL_OFFSET} y={yOf(layout, tick.position) + 3} className="parallel-axis-tick">
            {tick.label}
          </text>
        </g>
      ))}
      {brush && (
        <rect
          x={x - AXIS_HIT_WIDTH / 4}
          width={AXIS_HIT_WIDTH / 2}
          y={brushTop}
          height={Math.max(2, brushBottom - brushTop)}
          className="parallel-brush"
        />
      )}
      <rect
        x={x - AXIS_HIT_WIDTH / 2}
        width={AXIS_HIT_WIDTH}
        y={layout.plotTop - 6}
        height={layout.plotBottom - layout.plotTop + 12}
        className="parallel-axis-hit"
        data-testid={`parallel-axis-${axisKey}`}
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </g>
  );
}

function ColorLegend({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <span className="parallel-color-legend">
      <span>{text.analysisColorLow}</span>
      <span
        className="parallel-color-ramp"
        style={{ background: `linear-gradient(to right, ${rampStops(theme).join(', ')})` }}
      />
      <span>{text.analysisColorHigh}</span>
      <span className="parallel-color-missing" />
      <span>{text.analysisColorMissing}</span>
    </span>
  );
}
