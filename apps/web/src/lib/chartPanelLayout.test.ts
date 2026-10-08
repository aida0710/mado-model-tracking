import { describe, expect, it } from 'vitest';
import type { ChartPanelConfig, ChartPanelLayout } from '@mmt/contracts';
import {
  addPanel,
  createDefaultLayout,
  createPanelConfig,
  emptyChartPanelLayout,
  getPanelMetricKeys,
  MAX_DEFAULT_PANELS,
  movePanel,
  parseChartPanelLayout,
  removePanel,
  resizePanel,
  setPanelsGroupBy,
} from './chartPanelLayout';

const panel = (id: string, layout: ChartPanelConfig['layout'], keys = [id]): ChartPanelConfig => ({
  ...createPanelConfig(keys),
  id,
  layout,
});
const layoutOf = (...panels: ChartPanelConfig[]): ChartPanelLayout => ({
  ...emptyChartPanelLayout(),
  panels,
});
const positions = (layout: ChartPanelLayout) =>
  Object.fromEntries(layout.panels.map((item) => [item.id, item.layout]));

describe('addPanel', () => {
  it('places a new panel in the first free cell of the top row', () => {
    const layout = layoutOf(panel('a', { x: 0, y: 0, w: 4, h: 2 }), panel('c', { x: 8, y: 0, w: 4, h: 2 }));
    const added = addPanel(layout, createPanelConfig(['loss']), { id: 'b' });
    expect(positions(added).b).toEqual({ x: 4, y: 0, w: 4, h: 2 });
  });

  it('starts a new row below when no row has room for the width', () => {
    const layout = layoutOf(panel('a', { x: 0, y: 0, w: 6, h: 2 }), panel('b', { x: 6, y: 0, w: 4, h: 2 }));
    const added = addPanel(layout, createPanelConfig(['loss']), { id: 'c', width: 'half' });
    expect(positions(added).c).toEqual({ x: 0, y: 2, w: 6, h: 2 });
  });
});

describe('removePanel', () => {
  it('pulls the panels below up into the freed space', () => {
    const layout = layoutOf(
      panel('a', { x: 0, y: 0, w: 12, h: 2 }),
      panel('b', { x: 0, y: 2, w: 4, h: 3 }),
      panel('c', { x: 4, y: 2, w: 4, h: 2 }),
    );
    const removed = removePanel(layout, 'a');
    expect(positions(removed)).toEqual({
      b: { x: 0, y: 0, w: 4, h: 3 },
      c: { x: 4, y: 0, w: 4, h: 2 },
    });
  });
});

describe('resizePanel', () => {
  it('pushes the overlapped neighbor down when a panel grows to full width', () => {
    const layout = layoutOf(panel('a', { x: 0, y: 0, w: 4, h: 2 }), panel('b', { x: 4, y: 0, w: 4, h: 2 }));
    const resized = resizePanel(layout, 'a', { width: 'full', height: 'tall' });
    expect(positions(resized)).toEqual({
      a: { x: 0, y: 0, w: 12, h: 3 },
      b: { x: 4, y: 3, w: 4, h: 2 },
    });
  });

  it('keeps a widened panel inside the grid', () => {
    const resized = resizePanel(layoutOf(panel('a', { x: 8, y: 0, w: 4, h: 2 })), 'a', { width: 'half' });
    expect(positions(resized).a).toEqual({ x: 6, y: 0, w: 6, h: 2 });
  });
});

describe('movePanel', () => {
  const row = layoutOf(
    panel('a', { x: 0, y: 0, w: 4, h: 2 }),
    panel('b', { x: 4, y: 0, w: 4, h: 2 }),
    panel('c', { x: 0, y: 2, w: 4, h: 2 }),
  );

  it('swaps places with the left and right neighbors', () => {
    expect(positions(movePanel(row, 'b', 'left'))).toMatchObject({
      a: { x: 4, y: 0 },
      b: { x: 0, y: 0 },
    });
    expect(positions(movePanel(row, 'a', 'right'))).toMatchObject({
      a: { x: 4, y: 0 },
      b: { x: 0, y: 0 },
    });
  });

  it('swaps rows with the panel above or below', () => {
    expect(positions(movePanel(row, 'c', 'up'))).toMatchObject({ c: { y: 0 }, a: { y: 2 } });
    expect(positions(movePanel(row, 'a', 'down'))).toMatchObject({ c: { y: 0 }, a: { y: 2 } });
  });

  it('slides to the grid edge without a neighbor and stays at the top or bottom', () => {
    expect(positions(movePanel(row, 'b', 'right')).b).toMatchObject({ x: 8, y: 0 });
    expect(movePanel(row, 'a', 'up')).toBe(row);
    expect(movePanel(row, 'c', 'down')).toBe(row);
  });
});

describe('createDefaultLayout', () => {
  it('puts keys of one prefix together and starts each prefix on a new row', () => {
    const layout = createDefaultLayout(
      ['train/loss', 'eval/loss', 'lr', 'train/accuracy', 'eval/wer'],
      (index) => `p${index}`,
    );
    const placed = layout.panels.map((item) => [item.metricKeys[0], item.layout.x, item.layout.y]);
    expect(placed).toEqual([
      ['lr', 0, 0],
      ['eval/loss', 0, 2],
      ['eval/wer', 4, 2],
      ['train/accuracy', 0, 4],
      ['train/loss', 4, 4],
    ]);
  });

  it('stops at the default panel limit', () => {
    const keys = Array.from({ length: MAX_DEFAULT_PANELS + 5 }, (_, index) => `m${index}`);
    expect(createDefaultLayout(keys, String).panels).toHaveLength(MAX_DEFAULT_PANELS);
  });
});

describe('parseChartPanelLayout', () => {
  const valid = layoutOf(panel('a', { x: 0, y: 0, w: 4, h: 2 }, ['loss', 'accuracy']));

  it('accepts a stored layout after a JSON round trip', () => {
    expect(parseChartPanelLayout(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it.each([
    ['another version', { ...valid, version: 2 }],
    ['a panel without metric keys', layoutOf({ ...valid.panels[0]!, metricKeys: [] })],
    ['more than ten metric keys', layoutOf({ ...valid.panels[0]!, metricKeys: Array.from({ length: 11 }, String) })],
    ['a panel outside the grid', layoutOf(panel('a', { x: 10, y: 0, w: 4, h: 2 }))],
    ['a metric x axis without a key', layoutOf({ ...valid.panels[0]!, xAxis: { kind: 'metric' } })],
    ['smoothing above 1', layoutOf({ ...valid.panels[0]!, smoothing: { kind: 'ema', weight: 2 } })],
    ['a tag grouping without a key', layoutOf({ ...valid.panels[0]!, groupBy: { kind: 'tag' } })],
    ['duplicate panel ids', layoutOf(valid.panels[0]!, { ...valid.panels[0]!, layout: { x: 4, y: 0, w: 4, h: 2 } })],
    ['a string', 'not a layout'],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(parseChartPanelLayout(value)).toBeNull();
  });

  it('settles overlapping panels of a hand-edited layout', () => {
    const parsed = parseChartPanelLayout(
      layoutOf(panel('a', { x: 0, y: 0, w: 6, h: 2 }), panel('b', { x: 4, y: 0, w: 6, h: 2 })),
    );
    expect(positions(parsed!).b).toEqual({ x: 4, y: 2, w: 6, h: 2 });
  });
});

describe('panel helpers', () => {
  it('sets and clears one grouping for every panel', () => {
    const layout = layoutOf(panel('a', { x: 0, y: 0, w: 4, h: 2 }), panel('b', { x: 4, y: 0, w: 4, h: 2 }));
    const grouped = setPanelsGroupBy(layout, { kind: 'tag', key: 'model' });
    expect(grouped.panels.map((item) => item.groupBy)).toEqual([
      { kind: 'tag', key: 'model' },
      { kind: 'tag', key: 'model' },
    ]);
    expect(setPanelsGroupBy(grouped, undefined).panels.every((item) => !('groupBy' in item))).toBe(true);
  });

  it('lists every drawn metric key once', () => {
    const layout = layoutOf(
      panel('a', { x: 0, y: 0, w: 4, h: 2 }, ['loss', 'lr']),
      panel('b', { x: 4, y: 0, w: 4, h: 2 }, ['loss']),
    );
    expect(getPanelMetricKeys(layout)).toEqual(['loss', 'lr']);
  });
});
