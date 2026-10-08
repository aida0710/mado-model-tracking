// Pure logic behind the parallel coordinates chart: where a value sits on an axis, which Runs a
// brush keeps, axis reordering and the single-hue color ramp. Positions are normalized: 0 is the
// bottom of the value range, 1 the top, and null means the Run has no value (the "missing" band).

export type AxisScaleKind = 'linear' | 'log' | 'categorical';

/** One vertical axis: a param, a metric or the sweep objective, identified by `key`. */
export interface AxisDefinition {
  key: string;
  label: string;
  kind: 'numeric' | 'categorical';
  /** Categorical axes only: the category order from the API; values not listed are appended. */
  categories?: string[];
}

export interface AxisScale {
  kind: AxisScaleKind;
  /** null when the value is missing or cannot be placed on this axis. */
  position: (value: unknown) => number | null;
  /** Labels at fixed positions, bottom to top. */
  ticks: { position: number; label: string }[];
}

/** A drag on one axis keeps the Runs whose position is within [from, to] (inclusive). */
export interface AxisBrush {
  axisKey: string;
  from: number;
  to: number;
}

export interface ParallelRow {
  runId: string;
  values: Record<string, unknown>;
}

/** A Run as the analysis charts draw it: `values` is keyed by AxisDefinition.key. */
export interface ChartRunRow extends ParallelRow {
  name: string;
}

// Same rule as the API (docs/api-contract.md): decimal and exponent forms only, so '0x10' and
// 'Infinity' stay categorical.
const NUMERIC_STRING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NUMERIC_TICK_COUNT = 5;
// A single category or a constant numeric axis sits in the middle instead of on an edge.
const SINGLE_VALUE_POSITION = 0.5;

/** The finite number a param or metric value stands for, or null. */
export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMERIC_STRING.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The category string of a value, matching the API's `values` (JSON for objects and arrays). */
export function categoryLabel(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function finiteRange(values: unknown[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    const number = numericValue(value);
    if (number === null) continue;
    if (number < min) min = number;
    if (number > max) max = number;
  }
  return min <= max ? { min, max } : null;
}

/** Log scale is offered only when every value on the axis is positive. */
export function canUseLogScale(values: unknown[]): boolean {
  const range = finiteRange(values);
  return range !== null && range.min > 0;
}

function compactNumber(value: number): string {
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e5 || magnitude < 1e-3) return value.toExponential(2);
  return String(Number(value.toPrecision(4)));
}

function createNumericScale(values: unknown[], requestLog: boolean): AxisScale {
  const range = finiteRange(values);
  const useLog = requestLog && range !== null && range.min > 0;
  const transform = useLog ? Math.log10 : (value: number) => value;
  const low = range ? transform(range.min) : 0;
  const high = range ? transform(range.max) : 0;
  const span = high - low;
  const position = (value: unknown) => {
    const number = numericValue(value);
    if (number === null || range === null) return null;
    if (useLog && number <= 0) return null;
    return span === 0 ? SINGLE_VALUE_POSITION : (transform(number) - low) / span;
  };
  const ticks = !range
    ? []
    : span === 0
      ? [{ position: SINGLE_VALUE_POSITION, label: compactNumber(range.min) }]
      : Array.from({ length: NUMERIC_TICK_COUNT }, (_, index) => {
          const tickPosition = index / (NUMERIC_TICK_COUNT - 1);
          const transformed = low + span * tickPosition;
          return { position: tickPosition, label: compactNumber(useLog ? 10 ** transformed : transformed) };
        });
  return { kind: useLog ? 'log' : 'linear', position, ticks };
}

function createCategoricalScale(definition: AxisDefinition, values: unknown[]): AxisScale {
  const categories = [...(definition.categories ?? [])];
  const known = new Set(categories);
  const unlisted = new Set<string>();
  for (const value of values) {
    const label = categoryLabel(value);
    if (label !== null && !known.has(label)) unlisted.add(label);
  }
  categories.push(...[...unlisted].sort());
  const indexOf = new Map(categories.map((category, index) => [category, index]));
  const categoryPosition = (index: number) =>
    categories.length === 1 ? SINGLE_VALUE_POSITION : index / (categories.length - 1);
  return {
    kind: 'categorical',
    position: (value) => {
      const label = categoryLabel(value);
      const index = label === null ? undefined : indexOf.get(label);
      return index === undefined ? null : categoryPosition(index);
    },
    ticks: categories.map((category, index) => ({ position: categoryPosition(index), label: category })),
  };
}

/**
 * The scale of one axis over the values it shows. Numeric axes are linear, or log when requested
 * and every value is positive; categorical axes space their categories evenly.
 */
export function createAxisScale(definition: AxisDefinition, values: unknown[], options: { log: boolean }): AxisScale {
  return definition.kind === 'numeric'
    ? createNumericScale(values, options.log)
    : createCategoricalScale(definition, values);
}

/** A brush never keeps a missing value: an absent value is not inside any range. */
export function isWithinBrush(position: number | null, brush: AxisBrush): boolean {
  if (position === null) return false;
  const low = Math.min(brush.from, brush.to);
  const high = Math.max(brush.from, brush.to);
  return position >= low && position <= high;
}

/** Axis positions of every row, computed once per scale change so brushing only compares numbers. */
export function computePositions(
  rows: ParallelRow[],
  axes: { key: string; scale: AxisScale }[],
): Map<string, (number | null)[]> {
  return new Map(axes.map((axis) => [axis.key, rows.map((row) => axis.scale.position(row.values[axis.key]))]));
}

/** Indexes of the rows inside every brush (all rows without brushes). */
export function selectRowIndexes(
  rowCount: number,
  positions: Map<string, (number | null)[]>,
  brushes: AxisBrush[],
): number[] {
  const active = brushes.flatMap((brush) => {
    const axisPositions = positions.get(brush.axisKey);
    return axisPositions ? [{ brush, axisPositions }] : [];
  });
  const selected: number[] = [];
  for (let index = 0; index < rowCount; index += 1)
    if (active.every(({ brush, axisPositions }) => isWithinBrush(axisPositions[index] ?? null, brush)))
      selected.push(index);
  return selected;
}

/** The axis order after moving `key` by `offset` places; out-of-range moves keep the order. */
export function moveAxis(order: string[], key: string, offset: number): string[] {
  const from = order.indexOf(key);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}

// Single-hue blue ramp (dataviz reference palette, steps 250 to 700). Light-on-dark reverses it so
// the best values stay the most visible against either surface.
const LIGHT_RAMP = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281', '#0d366b'];
const DARK_RAMP = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
export const MISSING_COLOR_VALUE = '#9a9a96';

/** The line color for a normalized color value; null (no value) is a neutral gray. */
export function rampColor(position: number | null, theme: 'light' | 'dark'): string {
  if (position === null) return MISSING_COLOR_VALUE;
  const ramp = theme === 'dark' ? DARK_RAMP : LIGHT_RAMP;
  const clamped = Math.min(1, Math.max(0, position));
  return ramp[Math.round(clamped * (ramp.length - 1))]!;
}

/** The ramp end points, for the legend gradient. */
export function rampStops(theme: 'light' | 'dark'): string[] {
  return theme === 'dark' ? [...DARK_RAMP] : [...LIGHT_RAMP];
}
