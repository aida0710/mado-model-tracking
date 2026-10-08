import { describe, expect, it } from 'vitest';
import {
  canUseLogScale,
  computePositions,
  createAxisScale,
  isWithinBrush,
  moveAxis,
  numericValue,
  rampColor,
  selectRowIndexes,
  type AxisDefinition,
} from './parallelCoordinates';

const numericAxis: AxisDefinition = { key: 'params.lr', label: 'lr', kind: 'numeric' };
const categoricalAxis: AxisDefinition = {
  key: 'params.optimizer',
  label: 'optimizer',
  kind: 'categorical',
  categories: ['adam', 'sgd', 'true'],
};

describe('平行座標の軸', () => {
  it('数値軸は最小値を下端、最大値を上端に線形で置き、数値として読める文字列も置く', () => {
    const scale = createAxisScale(numericAxis, [0, 5, '10', null], { log: false });
    expect(scale.kind).toBe('linear');
    expect(scale.position(0)).toBe(0);
    expect(scale.position('5')).toBe(0.5);
    expect(scale.position(10)).toBe(1);
    expect(scale.ticks.map((tick) => tick.label)).toEqual(['0', '2.5', '5', '7.5', '10']);
  });

  it('対数軸は桁を等間隔に置き、正でない値があれば線形のままにする', () => {
    const log = createAxisScale(numericAxis, [1e-4, 1e-3, 1e-2], { log: true });
    expect(log.kind).toBe('log');
    expect(log.position(1e-3)).toBeCloseTo(0.5);
    expect(canUseLogScale([1e-4, 1e-2])).toBe(true);
    expect(canUseLogScale([0, 1])).toBe(false);
    expect(createAxisScale(numericAxis, [0, 1], { log: true }).kind).toBe('linear');
  });

  it('値が1種類だけの軸は中央に置く', () => {
    expect(createAxisScale(numericAxis, [3, 3], { log: false }).position(3)).toBe(0.5);
    expect(createAxisScale({ ...categoricalAxis, categories: ['adam'] }, ['adam'], { log: false }).position('adam')).toBe(0.5);
  });

  it('カテゴリ軸はAPIの順に等間隔で置き、真偽値は文字列の値として扱う', () => {
    const scale = createAxisScale(categoricalAxis, ['adam', 'sgd', true], { log: false });
    expect(scale.position('adam')).toBe(0);
    expect(scale.position('sgd')).toBe(0.5);
    expect(scale.position(true)).toBe(1);
    expect(scale.ticks.map((tick) => tick.label)).toEqual(['adam', 'sgd', 'true']);
  });

  it('欠損値・非有限値・カテゴリに無い数値は位置を持たず欠損帯に置かれる', () => {
    const numeric = createAxisScale(numericAxis, [1, 2], { log: false });
    expect(numeric.position(undefined)).toBeNull();
    expect(numeric.position(null)).toBeNull();
    expect(numeric.position('0x10')).toBeNull();
    expect(numeric.position('Infinity')).toBeNull();
    expect(numericValue(Number.NaN)).toBeNull();
    const empty = createAxisScale(numericAxis, [null, undefined], { log: false });
    expect(empty.position(1)).toBeNull();
    expect(empty.ticks).toEqual([]);
  });
});

describe('brushによる絞り込み', () => {
  it('範囲の境界ちょうどの値を含み、向きに関係なく同じ範囲になる', () => {
    expect(isWithinBrush(0.2, { axisKey: 'a', from: 0.2, to: 0.6 })).toBe(true);
    expect(isWithinBrush(0.6, { axisKey: 'a', from: 0.6, to: 0.2 })).toBe(true);
    expect(isWithinBrush(0.6000001, { axisKey: 'a', from: 0.2, to: 0.6 })).toBe(false);
  });

  it('欠損値はどの範囲にも入らない', () => {
    expect(isWithinBrush(null, { axisKey: 'a', from: 0, to: 1 })).toBe(false);
  });

  it('複数の軸のbrushはすべてを満たすRunだけを残す', () => {
    const rows = [
      { runId: 'r1', values: { lr: 0, loss: 1 } },
      { runId: 'r2', values: { lr: 5, loss: 0 } },
      { runId: 'r3', values: { lr: 10, loss: 0.5 } },
      { runId: 'r4', values: { loss: 0.2 } },
    ];
    const axes = [
      { key: 'lr', scale: createAxisScale({ key: 'lr', label: 'lr', kind: 'numeric' }, [0, 5, 10], { log: false }) },
      { key: 'loss', scale: createAxisScale({ key: 'loss', label: 'loss', kind: 'numeric' }, [0, 0.2, 0.5, 1], { log: false }) },
    ];
    const positions = computePositions(rows, axes);
    expect(selectRowIndexes(rows.length, positions, [])).toEqual([0, 1, 2, 3]);
    expect(selectRowIndexes(rows.length, positions, [{ axisKey: 'lr', from: 0.5, to: 1 }])).toEqual([1, 2]);
    expect(
      selectRowIndexes(rows.length, positions, [
        { axisKey: 'lr', from: 0.5, to: 1 },
        { axisKey: 'loss', from: 0.4, to: 0.6 },
      ]),
    ).toEqual([2]);
  });

  it('表示していない軸のbrushは無視する', () => {
    const positions = new Map([['lr', [0, 1]]]);
    expect(selectRowIndexes(2, positions, [{ axisKey: 'gone', from: 0, to: 0.1 }])).toEqual([0, 1]);
  });
});

describe('軸の並べ替えと色', () => {
  it('軸を左右へ動かし、端を越える移動では並びを変えない', () => {
    expect(moveAxis(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveAxis(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
    expect(moveAxis(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveAxis(['a', 'b', 'c'], 'missing', 1)).toEqual(['a', 'b', 'c']);
  });

  it('色は単色の明暗で、明るい背景では値が大きいほど濃く、欠損は灰色になる', () => {
    expect(rampColor(0, 'light')).toBe('#86b6ef');
    expect(rampColor(1, 'light')).toBe('#0d366b');
    expect(rampColor(1, 'dark')).toBe('#cde2fb');
    expect(rampColor(null, 'light')).toBe('#9a9a96');
  });
});
