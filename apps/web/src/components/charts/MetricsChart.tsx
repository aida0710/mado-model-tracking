import { useId, useMemo, useState, type MouseEvent } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
  usePlotArea,
  useXAxisInverseScale,
  useXAxisScale,
  useYAxisScale,
} from 'recharts';
import type { MetricXRange } from '@mmt/contracts';
import type { MetricsChartMarker, MetricsChartProps } from './chartProps';
import { ChartLegend } from './ChartLegend';
import { ChartTooltip } from './ChartTooltip';
import { Empty } from '../Feedback';
import { bandPath, linePath, paddedDomain, xExtent, type PixelScale } from '../../lib/chartScale';
import { formatXTick, formatXValue } from '../../lib/chartXAxis';
import { formatChartTick } from '../../lib/chartTicks';
import { prepareChartLines, valuesAtX, type ChartLine } from '../../lib/metricSeries';
import { text, textTemplates } from '../../i18n/catalog';

const DEFAULT_CHART_HEIGHT = 320;
const CHART_MARGIN = { top: 16, right: 24, left: 8, bottom: 8 };
const Y_AXIS_WIDTH = 70;
// About the rows that fit beside the pointer without covering the chart.
const TOOLTIP_MAX_ROWS = 10;
// Gap between the pointer and the tooltip box.
const TOOLTIP_OFFSET_PIXELS = 14;
// A shorter drag is a click, not a zoom.
const MIN_ZOOM_DRAG_PIXELS = 6;

interface HoverPosition {
  x: number;
  pixelX: number;
  pixelY: number;
  chartWidth: number;
}

/**
 * Metric lines of Runs and Run groups, drawn from the data it is given (it fetches nothing, so a
 * report can pass saved data). Lines and bands are single SVG paths per series so 200 Runs stay
 * light; recharts draws the axes and grid. Hover shows the values at x, dragging zooms into x.
 */
export function MetricsChart({
  series,
  xAxis,
  xScale = 'linear',
  yScale,
  valueUnit = 'number',
  smoothing,
  showRange,
  showRaw,
  markers = [],
  height = DEFAULT_CHART_HEIGHT,
  onZoom,
}: MetricsChartProps) {
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [zoomRange, setZoomRange] = useState<MetricXRange | null>(null);
  const [hover, setHover] = useState<HoverPosition | null>(null);

  const lines = useMemo(
    () => prepareChartLines(series, { xScale, yScale, smoothing }),
    [series, xScale, yScale, smoothing],
  );
  const visibleLines = useMemo(
    () => lines.filter((line) => !hiddenIds.has(line.id)),
    [lines, hiddenIds],
  );
  const isSmoothed = smoothing.kind !== 'none' && smoothing.weight > 0;
  const xDomain = useMemo(
    () =>
      zoomRange
        ? ([zoomRange.min, zoomRange.max] as [number, number])
        : xExtent(
            visibleLines.flatMap((line) => line.points.map((point) => point.x)),
            xScale,
          ),
    [visibleLines, zoomRange, xScale],
  );
  const yDomain = useMemo(
    () =>
      xDomain &&
      paddedDomain(
        visibleLineValuesIn(visibleLines, xDomain, { showRange, showRaw: showRaw && isSmoothed }),
        yScale,
      ),
    [visibleLines, xDomain, showRange, showRaw, isSmoothed, yScale],
  );
  const excludedCount = lines.reduce((sum, line) => sum + line.excludedCount, 0);

  function changeZoom(range: MetricXRange | null) {
    setZoomRange(range);
    setHover(null);
    onZoom?.(range);
  }

  function toggleLine(id: string) {
    setHiddenIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const legend = (
    <ChartLegend
      lines={lines}
      hiddenIds={hiddenIds}
      onToggle={toggleLine}
      onHighlight={setHighlightedId}
      onShowAll={() => setHiddenIds(new Set())}
    />
  );
  if (!xDomain || !yDomain)
    return (
      <div className="metrics-chart">
        {lines.length > 0 && legend}
        <Empty>{text.chartNoData}</Empty>
      </div>
    );

  const tooltip =
    hover && valuesAtX(visibleLines, hover.x, { highlightedId, maxRows: TOOLTIP_MAX_ROWS });
  // Two corners of the domain give recharts' axes data to measure; the series draw themselves.
  const domainCorners = [
    { x: xDomain[0], y: yDomain[0] },
    { x: xDomain[1], y: yDomain[1] },
  ];
  return (
    <div className="metrics-chart">
      {legend}
      <div
        className="metrics-chart-canvas"
        style={{ height }}
        role="img"
        aria-label={textTemplates.chartAriaLabel(lines.length)}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={domainCorners} margin={CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              type="number"
              dataKey="x"
              domain={xDomain}
              scale={xScale}
              allowDataOverflow
              allowDecimals={xAxis.kind !== 'step'}
              tickFormatter={(value: number) => formatXTick(xAxis, value)}
              tick={{ fontSize: 11 }}
            />
            {/* 'auto' rounds the corners' y span out to round ticks; the lines use the same scale. */}
            <YAxis
              type="number"
              dataKey="y"
              domain={['auto', 'auto']}
              scale={yScale}
              width={Y_AXIS_WIDTH}
              tickFormatter={(value: number) => formatChartTick(value, valueUnit)}
              tick={{ fontSize: 11 }}
            />
            {/* Invisible: gives recharts a graphical item that reads the corners for the axes. */}
            <Line
              dataKey="y"
              stroke="none"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
            <ChartPlotLayer
              lines={visibleLines}
              highlightedId={highlightedId}
              showRange={showRange}
              showRaw={showRaw && isSmoothed}
              markers={markers}
              hoverPixelX={hover?.pixelX ?? null}
              onHover={setHover}
              onZoom={changeZoom}
            />
          </ComposedChart>
        </ResponsiveContainer>
        {hover && tooltip && tooltip.rows.length > 0 && (
          <ChartTooltip
            xText={formatXValue(xAxis, hover.x)}
            rows={tooltip.rows}
            hiddenRowCount={tooltip.hiddenRowCount}
            position={{
              alignRight: hover.pixelX > hover.chartWidth / 2,
              left:
                hover.pixelX > hover.chartWidth / 2
                  ? hover.pixelX - TOOLTIP_OFFSET_PIXELS
                  : hover.pixelX + TOOLTIP_OFFSET_PIXELS,
              top: hover.pixelY + TOOLTIP_OFFSET_PIXELS,
            }}
          />
        )}
      </div>
      <div className="metrics-chart-footer">
        {excludedCount > 0 && (
          <span className="chart-note">{textTemplates.chartLogExcluded(excludedCount)}</span>
        )}
        {zoomRange ? (
          <button type="button" className="button small" onClick={() => changeZoom(null)}>
            {text.chartResetZoom}
          </button>
        ) : (
          <span className="chart-note">{text.chartZoomHint}</span>
        )}
      </div>
    </div>
  );
}

/** The values the y axis must show: drawn lines inside the x domain, and bands when shown. */
function* visibleLineValuesIn(
  lines: readonly ChartLine[],
  [minX, maxX]: [number, number],
  shown: { showRange: boolean; showRaw: boolean },
): Generator<number> {
  for (const line of lines) {
    for (const [index, point] of line.points.entries()) {
      if (point.x < minX || point.x > maxX) continue;
      yield line.smoothedValues[index]!;
      if (shown.showRaw) yield point.value;
      if (shown.showRange && point.min !== undefined && point.max !== undefined) {
        yield point.min;
        yield point.max;
      }
    }
  }
}

/**
 * Draws inside recharts' plot area with its scales: bands, faint raw lines, the lines, resume
 * markers, the hover cursor and the zoom selection. A transparent rect on top takes the pointer.
 */
function ChartPlotLayer({
  lines,
  highlightedId,
  showRange,
  showRaw,
  markers,
  hoverPixelX,
  onHover,
  onZoom,
}: {
  lines: readonly ChartLine[];
  highlightedId: string | null;
  showRange: boolean;
  showRaw: boolean;
  markers: readonly MetricsChartMarker[];
  hoverPixelX: number | null;
  onHover: (hover: HoverPosition | null) => void;
  onZoom: (range: MetricXRange) => void;
}) {
  const clipPathId = `chart-clip-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const xScaleFunction = useXAxisScale();
  const yScaleFunction = useYAxisScale();
  const invertX = useXAxisInverseScale();
  const plotArea = usePlotArea();
  const [dragStartPixelX, setDragStartPixelX] = useState<number | null>(null);
  const scales = useMemo(
    (): { x: PixelScale; y: PixelScale } | null =>
      xScaleFunction && yScaleFunction ? { x: xScaleFunction, y: yScaleFunction } : null,
    [xScaleFunction, yScaleFunction],
  );
  const paths = useMemo(
    () =>
      scales
        ? lines.map((line) => {
            const xs = line.points.map((point) => point.x);
            return {
              line,
              band: showRange ? bandPath(line.points, scales) : '',
              raw: showRaw ? linePath(xs, line.points.map((point) => point.value), scales) : '',
              smoothed: linePath(xs, line.smoothedValues, scales),
            };
          })
        : [],
    [lines, scales, showRange, showRaw],
  );
  if (!scales || !invertX || !plotArea) return null;

  const pointerX = (event: MouseEvent<SVGRectElement>) => {
    const svgBox = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    return {
      pixelX: event.clientX - (svgBox?.left ?? 0),
      pixelY: event.clientY - (svgBox?.top ?? 0),
      chartWidth: svgBox?.width ?? 0,
    };
  };
  const dataX = (pixelX: number) => Number(invertX(pixelX));

  function finishDrag(event: MouseEvent<SVGRectElement>) {
    if (dragStartPixelX === null) return;
    const { pixelX } = pointerX(event);
    setDragStartPixelX(null);
    if (Math.abs(pixelX - dragStartPixelX) < MIN_ZOOM_DRAG_PIXELS) return;
    const [min, max] = [dataX(dragStartPixelX), dataX(pixelX)].sort((left, right) => left - right);
    if (Number.isFinite(min) && Number.isFinite(max)) onZoom({ min: min!, max: max! });
  }

  const isDimmed = (line: ChartLine) => highlightedId !== null && line.id !== highlightedId;
  // The highlighted line is drawn last so it lies on top.
  const ordered = [...paths].sort(
    (left, right) => Number(left.line.id === highlightedId) - Number(right.line.id === highlightedId),
  );
  return (
    <g className="chart-plot-layer">
      <defs>
        <clipPath id={clipPathId}>
          <rect x={plotArea.x} y={plotArea.y} width={plotArea.width} height={plotArea.height} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipPathId})`}>
        {ordered.map(({ line, band }) =>
          band ? (
            <path
              key={`band-${line.id}`}
              d={band}
              fill={line.color}
              className={`chart-band ${line.kind}${isDimmed(line) ? ' dimmed' : ''}`}
            />
          ) : null,
        )}
        {ordered.map(({ line, raw }) =>
          raw ? (
            <path
              key={`raw-${line.id}`}
              d={raw}
              stroke={line.color}
              className={`chart-raw-line${isDimmed(line) ? ' dimmed' : ''}`}
            />
          ) : null,
        )}
        {ordered.map(({ line, smoothed }) => (
          <path
            key={`line-${line.id}`}
            d={smoothed}
            stroke={line.color}
            className={`chart-line ${line.kind}${isDimmed(line) ? ' dimmed' : ''}${
              line.id === highlightedId ? ' highlighted' : ''
            }`}
          />
        ))}
        {markers.map((marker, index) => {
          const pixelX = scales.x(marker.x);
          if (pixelX === undefined || !Number.isFinite(pixelX)) return null;
          return (
            <g key={`marker-${index}`} className="chart-marker">
              <line x1={pixelX} x2={pixelX} y1={plotArea.y} y2={plotArea.y + plotArea.height} />
              <text x={pixelX + 4} y={plotArea.y + 12}>
                {marker.label}
              </text>
            </g>
          );
        })}
        {hoverPixelX !== null && (
          <line
            className="chart-cursor"
            x1={hoverPixelX}
            x2={hoverPixelX}
            y1={plotArea.y}
            y2={plotArea.y + plotArea.height}
          />
        )}
        {dragStartPixelX !== null && hoverPixelX !== null && (
          <rect
            className="chart-zoom-selection"
            x={Math.min(dragStartPixelX, hoverPixelX)}
            y={plotArea.y}
            width={Math.abs(hoverPixelX - dragStartPixelX)}
            height={plotArea.height}
          />
        )}
      </g>
      <rect
        className="chart-pointer-area"
        x={plotArea.x}
        y={plotArea.y}
        width={plotArea.width}
        height={plotArea.height}
        onMouseMove={(event) => {
          const position = pointerX(event);
          onHover({ ...position, x: dataX(position.pixelX) });
        }}
        onMouseLeave={() => {
          setDragStartPixelX(null);
          onHover(null);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          setDragStartPixelX(pointerX(event).pixelX);
        }}
        onMouseUp={finishDrag}
      />
    </g>
  );
}

