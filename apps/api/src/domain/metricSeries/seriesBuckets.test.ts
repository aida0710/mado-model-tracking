import { describe, expect, it } from 'vitest';
import {
  assembleSeriesPoints,
  bucketBounds,
  planSeriesBuckets,
  planSharedBuckets,
  type SeriesBucketRow,
} from './seriesBuckets.js';

const extent = (xMin: number | null, xMax: number | null, totalPoints: number) => ({
  xMin,
  xMax,
  totalPoints,
});
const finiteRow = (x: number, value: number): SeriesBucketRow => ({
  x,
  step: x,
  value,
  minValue: value,
  maxValue: value,
  count: 1,
  nanCount: 0,
});
const nanOnlyRow = (nanCount: number): SeriesBucketRow => ({
  x: null,
  step: null,
  value: null,
  minValue: null,
  maxValue: null,
  count: 0,
  nanCount,
});

describe('bucketの境界', () => {
  it('xRangeがあればデータの範囲より優先し、拡大した範囲だけを等分する', () => {
    expect(bucketBounds(extent(0, 100000, 100001), { min: 100, max: 200 })).toEqual({
      lower: 100,
      upper: 200,
    });
    expect(bucketBounds(extent(0, 100000, 100001), null)).toEqual({ lower: 0, upper: 100000 });
  });

  it('xが1種類だけでも幅のあるbucketにして、その点を含める', () => {
    expect(bucketBounds(extent(5, 5, 3), null)).toEqual({ lower: 5, upper: 6 });
  });

  it('点が無い系列には境界を作らない', () => {
    expect(bucketBounds(extent(null, null, 0), null)).toBeNull();
    expect(planSeriesBuckets(extent(null, null, 0), { maxPoints: 10, xRange: null })).toBeNull();
    expect(planSharedBuckets(extent(null, null, 0), { maxPoints: 10, xRange: null })).toBeNull();
  });
});

describe('間引くかどうか', () => {
  it('点数がmaxPoints以下なら素の点を返し、超えたらmaxPoints個のbucketにする', () => {
    expect(planSeriesBuckets(extent(0, 999, 1000), { maxPoints: 1000, xRange: null })).toEqual({
      kind: 'raw',
    });
    expect(planSeriesBuckets(extent(0, 1000, 1001), { maxPoints: 1000, xRange: null })).toEqual({
      kind: 'buckets',
      lower: 0,
      upper: 1000,
      count: 1000,
    });
  });

  it('グループ用の境界は点数が少なくても常にbucketにする', () => {
    expect(planSharedBuckets(extent(0, 10, 11), { maxPoints: 1000, xRange: null })).toEqual({
      kind: 'buckets',
      lower: 0,
      upper: 10,
      count: 1000,
    });
  });
});

describe('bucketの組み立て', () => {
  it('NaNだけのbucketは点にせず、NaNの件数は全bucketで合計する', () => {
    const rows = [
      { ...finiteRow(1, 0.5), nanCount: 2 },
      nanOnlyRow(3),
      { ...finiteRow(3, 0.25), minValue: 0.1, maxValue: 9, count: 4 },
    ];
    expect(assembleSeriesPoints(rows)).toEqual({
      points: [
        { x: 1, step: 1, value: 0.5, min: 0.5, max: 0.5, count: 1 },
        { x: 3, step: 3, value: 0.25, min: 0.1, max: 9, count: 4 },
      ],
      nanCount: 5,
    });
  });

  it('全点がNaNなら点は空でnanCountだけが残る', () => {
    expect(assembleSeriesPoints([nanOnlyRow(4), nanOnlyRow(1)])).toEqual({
      points: [],
      nanCount: 5,
    });
  });

  it('値の無いbucketは行が無いので、点も作らない', () => {
    expect(assembleSeriesPoints([])).toEqual({ points: [], nanCount: 0 });
  });
});
