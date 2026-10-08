import type {
  ChartPanelConfig,
  ChartPanelLayout,
  ChartSmoothing,
  ChartXAxis,
  RunGroupBy,
} from '@mmt/contracts';

// Panel placement on the 12-column grid. Pure functions: every change returns a new layout whose
// panels never overlap and are pulled up as far as they fit, so a removed panel leaves no hole.

export const CHART_GRID_COLUMNS = 12;
/** More lines than this make one panel unreadable; the editor stops the selection here. */
export const MAX_PANEL_METRIC_KEYS = 10;
/** A metric-rich Run would otherwise open with hundreds of panels and one huge series request. */
export const MAX_DEFAULT_PANELS = 24;
/** The x axis and smoothing a new panel starts with: W&B's default view of a training curve. */
export const DEFAULT_PANEL_X_AXIS: ChartXAxis = { kind: 'step' };
export const DEFAULT_PANEL_SMOOTHING: ChartSmoothing = { kind: 'none', weight: 0 };

export const PANEL_WIDTHS = { third: 4, half: 6, full: 12 } as const;
export type PanelWidth = keyof typeof PANEL_WIDTHS;
/** Grid rows; one row is CHART_ROW_HEIGHT_PX in styles/chartPanels.css. */
export const PANEL_HEIGHTS = { normal: 2, tall: 3 } as const;
export type PanelHeight = keyof typeof PANEL_HEIGHTS;
export type PanelMoveDirection = 'up' | 'down' | 'left' | 'right';

type PanelRect = ChartPanelConfig['layout'];
export type NewChartPanel = Omit<ChartPanelConfig, 'id' | 'layout'>;

export const emptyChartPanelLayout = (): ChartPanelLayout => ({
  version: 1,
  columns: CHART_GRID_COLUMNS,
  panels: [],
});

export function createPanelConfig(metricKeys: string[], title?: string): NewChartPanel {
  return {
    ...(title ? { title } : {}),
    metricKeys: metricKeys.slice(0, MAX_PANEL_METRIC_KEYS),
    xAxis: DEFAULT_PANEL_X_AXIS,
    yScale: 'linear',
    smoothing: DEFAULT_PANEL_SMOOTHING,
    showRange: true,
  };
}

const overlaps = (left: PanelRect, right: PanelRect) =>
  left.x < right.x + right.w &&
  right.x < left.x + left.w &&
  left.y < right.y + right.h &&
  right.y < left.y + left.h;

const readingOrder = (left: ChartPanelConfig, right: ChartPanelConfig) =>
  left.layout.y - right.layout.y || left.layout.x - right.layout.x;

/**
 * Places panels in order, pushing each below whatever it overlaps, then pulls every panel up as
 * far as it fits. `priorityId` keeps its requested place and the others give way to it.
 */
function settlePanels(panels: ChartPanelConfig[], priorityId?: string): ChartPanelConfig[] {
  const ordered = [...panels].sort(
    (left, right) =>
      Number(right.id === priorityId) - Number(left.id === priorityId) || readingOrder(left, right),
  );
  const placed: ChartPanelConfig[] = [];
  for (const panel of ordered) {
    const rect = { ...panel.layout };
    for (;;) {
      const blockers = placed.filter((other) => overlaps(rect, other.layout));
      if (!blockers.length) break;
      rect.y = Math.max(...blockers.map((other) => other.layout.y + other.layout.h));
    }
    placed.push({ ...panel, layout: rect });
  }
  return compactPanels(placed);
}

function compactPanels(panels: ChartPanelConfig[]): ChartPanelConfig[] {
  const compacted: ChartPanelConfig[] = [];
  for (const panel of [...panels].sort(readingOrder)) {
    const rect = { ...panel.layout };
    while (rect.y > 0 && !compacted.some((other) => overlaps({ ...rect, y: rect.y - 1 }, other.layout)))
      rect.y -= 1;
    compacted.push({ ...panel, layout: rect });
  }
  return compacted.sort(readingOrder);
}

const withPanels = (layout: ChartPanelLayout, panels: ChartPanelConfig[]): ChartPanelLayout => ({
  ...layout,
  panels,
});

/** The first free place in reading order (top row first, then left to right). */
export function findFreePosition(
  panels: ChartPanelConfig[],
  size: { w: number; h: number },
): PanelRect {
  const bottom = Math.max(0, ...panels.map((panel) => panel.layout.y + panel.layout.h));
  for (let y = 0; y <= bottom; y += 1)
    for (let x = 0; x + size.w <= CHART_GRID_COLUMNS; x += 1) {
      const rect = { x, y, ...size };
      if (!panels.some((panel) => overlaps(rect, panel.layout))) return rect;
    }
  return { x: 0, y: bottom, ...size };
}

export function addPanel(
  layout: ChartPanelLayout,
  panel: NewChartPanel,
  options: { id: string; width?: PanelWidth; height?: PanelHeight },
): ChartPanelLayout {
  const size = {
    w: PANEL_WIDTHS[options.width ?? 'third'],
    h: PANEL_HEIGHTS[options.height ?? 'normal'],
  };
  const rect = findFreePosition(layout.panels, size);
  return withPanels(layout, [...layout.panels, { ...panel, id: options.id, layout: rect }]);
}

export function removePanel(layout: ChartPanelLayout, panelId: string): ChartPanelLayout {
  return withPanels(layout, compactPanels(layout.panels.filter((panel) => panel.id !== panelId)));
}

export function updatePanel(
  layout: ChartPanelLayout,
  panelId: string,
  changes: Partial<NewChartPanel>,
): ChartPanelLayout {
  return withPanels(
    layout,
    layout.panels.map((panel) => (panel.id === panelId ? { ...panel, ...changes } : panel)),
  );
}

export function resizePanel(
  layout: ChartPanelLayout,
  panelId: string,
  size: { width?: PanelWidth; height?: PanelHeight },
): ChartPanelLayout {
  const panels = layout.panels.map((panel) => {
    if (panel.id !== panelId) return panel;
    const w = size.width ? PANEL_WIDTHS[size.width] : panel.layout.w;
    const h = size.height ? PANEL_HEIGHTS[size.height] : panel.layout.h;
    return { ...panel, layout: { x: Math.min(panel.layout.x, CHART_GRID_COLUMNS - w), y: panel.layout.y, w, h } };
  });
  return withPanels(layout, settlePanels(panels, panelId));
}

const sharesRows = (left: PanelRect, right: PanelRect) =>
  left.y < right.y + right.h && right.y < left.y + left.h;
const sharesColumns = (left: PanelRect, right: PanelRect) =>
  left.x < right.x + right.w && right.x < left.x + left.w;

/** The closest panel next to `rect` on the given side, or undefined at the edge. */
function findNeighbor(
  panels: ChartPanelConfig[],
  rect: PanelRect,
  direction: PanelMoveDirection,
): ChartPanelConfig | undefined {
  const candidates = panels.filter((panel) => {
    const other = panel.layout;
    if (direction === 'left') return sharesRows(rect, other) && other.x + other.w <= rect.x;
    if (direction === 'right') return sharesRows(rect, other) && other.x >= rect.x + rect.w;
    if (direction === 'up') return sharesColumns(rect, other) && other.y + other.h <= rect.y;
    return sharesColumns(rect, other) && other.y >= rect.y + rect.h;
  });
  const distance = (panel: ChartPanelConfig) => {
    const other = panel.layout;
    if (direction === 'left') return rect.x - (other.x + other.w);
    if (direction === 'right') return other.x - (rect.x + rect.w);
    if (direction === 'up') return rect.y - (other.y + other.h);
    return other.y - (rect.y + rect.h);
  };
  return candidates.sort((left, right) => distance(left) - distance(right))[0];
}

/**
 * Swaps the panel with its neighbor on that side, the keyboard equivalent of dragging it there.
 * Without a neighbor a horizontal move slides the panel to the grid edge and a vertical one stays.
 */
export function movePanel(
  layout: ChartPanelLayout,
  panelId: string,
  direction: PanelMoveDirection,
): ChartPanelLayout {
  const moving = layout.panels.find((panel) => panel.id === panelId);
  if (!moving) return layout;
  const rect = moving.layout;
  const neighbor = findNeighbor(layout.panels, rect, direction);
  const moved = new Map<string, PanelRect>();
  if (direction === 'left' || direction === 'right') {
    if (neighbor) {
      const leftX = Math.min(rect.x, neighbor.layout.x);
      const [first, second] = direction === 'left' ? [rect, neighbor.layout] : [neighbor.layout, rect];
      const firstId = direction === 'left' ? moving.id : neighbor.id;
      const secondId = direction === 'left' ? neighbor.id : moving.id;
      moved.set(firstId, { ...first, x: leftX });
      moved.set(secondId, { ...second, x: Math.min(leftX + first.w, CHART_GRID_COLUMNS - second.w) });
    } else {
      const edgeX = direction === 'left' ? 0 : CHART_GRID_COLUMNS - rect.w;
      if (edgeX === rect.x) return layout;
      moved.set(moving.id, { ...rect, x: edgeX });
    }
  } else {
    if (!neighbor) return layout;
    if (direction === 'up') moved.set(moving.id, { ...rect, y: neighbor.layout.y });
    else moved.set(neighbor.id, { ...neighbor.layout, y: rect.y });
  }
  const panels = layout.panels.map((panel) => {
    const next = moved.get(panel.id);
    return next ? { ...panel, layout: next } : panel;
  });
  // A vertical move to the neighbor's row gives way to the panel that took the upper place.
  const priorityId = direction === 'down' && neighbor ? neighbor.id : moving.id;
  return withPanels(layout, settlePanels(panels, priorityId));
}

/** Applies one grouping to every panel; the Run list's grouping control sets it for all charts. */
export function setPanelsGroupBy(
  layout: ChartPanelLayout,
  groupBy: RunGroupBy | undefined,
): ChartPanelLayout {
  return withPanels(
    layout,
    layout.panels.map(({ groupBy: _previous, ...panel }) => (groupBy ? { ...panel, groupBy } : panel)),
  );
}

/** The section a key belongs to: the part before the first '/', as W&B groups `train/` and `eval/`. */
export function metricKeySection(key: string): string {
  const slash = key.indexOf('/');
  return slash > 0 ? key.slice(0, slash) : '';
}

/**
 * One panel per metric key, keys of the same prefix side by side and each prefix starting a new
 * row. Keys without a prefix come first. Stops at MAX_DEFAULT_PANELS.
 */
export function createDefaultLayout(
  metricKeys: string[],
  createId: (index: number) => string,
): ChartPanelLayout {
  const sections = new Map<string, string[]>();
  for (const key of [...new Set(metricKeys)].sort((left, right) => left.localeCompare(right))) {
    const section = metricKeySection(key);
    sections.set(section, [...(sections.get(section) ?? []), key]);
  }
  const ordered = [...sections.entries()].sort(([left], [right]) =>
    left === '' ? -1 : right === '' ? 1 : left.localeCompare(right),
  );
  const width = PANEL_WIDTHS.third;
  const height = PANEL_HEIGHTS.normal;
  const perRow = CHART_GRID_COLUMNS / width;
  const panels: ChartPanelConfig[] = [];
  let rowStart = 0;
  for (const [, keys] of ordered) {
    for (const [index, key] of keys.entries()) {
      if (panels.length >= MAX_DEFAULT_PANELS) break;
      panels.push({
        ...createPanelConfig([key]),
        id: createId(panels.length),
        layout: {
          x: (index % perRow) * width,
          y: rowStart + Math.floor(index / perRow) * height,
          w: width,
          h: height,
        },
      });
    }
    rowStart = Math.max(rowStart, ...panels.map((panel) => panel.layout.y + panel.layout.h));
  }
  return withPanels(emptyChartPanelLayout(), panels);
}

/** Every metric key the panels draw, in first-use order; the series request asks for these. */
export const getPanelMetricKeys = (layout: ChartPanelLayout) => [
  ...new Set(layout.panels.flatMap((panel) => panel.metricKeys)),
];

// ---- Validation of stored JSON (localStorage today, saved views later) ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const X_AXIS_KINDS: readonly string[] = ['step', 'relative_time', 'wall_time', 'metric'];
const SMOOTHING_KINDS: readonly string[] = ['none', 'ema', 'gaussian', 'running_average'];
const GROUP_KINDS: readonly string[] = ['tag', 'param', 'experiment'];

function parseXAxis(value: unknown): ChartXAxis | null {
  if (!isRecord(value) || typeof value.kind !== 'string' || !X_AXIS_KINDS.includes(value.kind))
    return null;
  if (value.kind !== 'metric') return { kind: value.kind as ChartXAxis['kind'] };
  return typeof value.metricKey === 'string' && value.metricKey
    ? { kind: 'metric', metricKey: value.metricKey }
    : null;
}

function parseSmoothing(value: unknown): ChartSmoothing | null {
  if (!isRecord(value) || typeof value.kind !== 'string' || !SMOOTHING_KINDS.includes(value.kind))
    return null;
  const weight = value.weight;
  if (typeof weight !== 'number' || !(weight >= 0 && weight <= 1)) return null;
  return { kind: value.kind as ChartSmoothing['kind'], weight };
}

function parseGroupBy(value: unknown): RunGroupBy | null {
  if (!isRecord(value) || typeof value.kind !== 'string' || !GROUP_KINDS.includes(value.kind))
    return null;
  if (value.kind === 'experiment') return { kind: 'experiment' };
  return typeof value.key === 'string' && value.key
    ? { kind: value.kind as RunGroupBy['kind'], key: value.key }
    : null;
}

function parseRect(value: unknown): PanelRect | null {
  if (!isRecord(value)) return null;
  const { x, y, w, h } = value;
  if (!isInteger(w, 1, CHART_GRID_COLUMNS) || !isInteger(x, 0, CHART_GRID_COLUMNS - w)) return null;
  if (!isInteger(y, 0, Number.MAX_SAFE_INTEGER) || !isInteger(h, 1, Number.MAX_SAFE_INTEGER))
    return null;
  return { x, y, w, h };
}

function parsePanel(value: unknown): ChartPanelConfig | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  const keys = value.metricKeys;
  if (
    !Array.isArray(keys) ||
    keys.length < 1 ||
    keys.length > MAX_PANEL_METRIC_KEYS ||
    !keys.every((key) => typeof key === 'string' && key)
  )
    return null;
  if (value.title !== undefined && typeof value.title !== 'string') return null;
  if (value.yScale !== 'linear' && value.yScale !== 'log') return null;
  if (typeof value.showRange !== 'boolean') return null;
  const xAxis = parseXAxis(value.xAxis);
  const smoothing = parseSmoothing(value.smoothing);
  const layout = parseRect(value.layout);
  const groupBy = value.groupBy === undefined ? undefined : parseGroupBy(value.groupBy);
  if (!xAxis || !smoothing || !layout || groupBy === null) return null;
  return {
    id: value.id,
    ...(value.title ? { title: value.title } : {}),
    metricKeys: [...new Set(keys as string[])],
    xAxis,
    yScale: value.yScale,
    smoothing,
    showRange: value.showRange,
    ...(groupBy ? { groupBy } : {}),
    layout,
  };
}

/**
 * Accepts a stored layout only when every panel is valid; a partly broken layout is rejected
 * whole rather than silently losing panels. Overlaps from a hand-edited layout are settled.
 */
export function parseChartPanelLayout(value: unknown): ChartPanelLayout | null {
  if (!isRecord(value) || value.version !== 1 || value.columns !== CHART_GRID_COLUMNS) return null;
  if (!Array.isArray(value.panels)) return null;
  const panels: ChartPanelConfig[] = [];
  for (const item of value.panels) {
    const panel = parsePanel(item);
    if (!panel || panels.some((other) => other.id === panel.id)) return null;
    panels.push(panel);
  }
  return withPanels(emptyChartPanelLayout(), settlePanels(panels));
}
