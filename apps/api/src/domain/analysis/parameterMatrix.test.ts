import { describe, expect, it } from 'vitest';
import { buildParameterMatrix, collectParameterNames, MAX_CATEGORY_LEVELS } from './parameterMatrix.js';

describe('buildParameterMatrix', () => {
  it('MLflow の文字列の数値 param を数値列として扱う', () => {
    const matrix = buildParameterMatrix({
      runs: [
        { parameters: { lr: '0.001' }, metrics: { loss: 1 } },
        { parameters: { lr: '1e-4' }, metrics: { loss: 2 } },
        { parameters: { lr: 0.5 }, metrics: { loss: 3 } },
      ],
      objectiveMetric: 'loss',
      parameterNames: ['lr'],
    });
    expect(matrix.columns[0]?.kind).toBe('numeric');
    expect(Array.from(matrix.columns[0]!.features[0]!.values)).toEqual([0.001, 0.0001, 0.5]);
  });

  it('数値に見えない文字列が混ざる列はカテゴリになり、水準ごとの one-hot 列を持つ', () => {
    const matrix = buildParameterMatrix({
      runs: [
        { parameters: { optimizer: 'adam' }, metrics: { loss: 1 } },
        { parameters: { optimizer: 'sgd' }, metrics: { loss: 2 } },
        { parameters: { optimizer: '0x10' }, metrics: { loss: 3 } },
      ],
      objectiveMetric: 'loss',
      parameterNames: ['optimizer'],
    });
    const column = matrix.columns[0]!;
    expect(column.kind).toBe('categorical');
    expect(column.features.map((feature) => feature.level)).toEqual(['0x10', 'adam', 'sgd']);
    expect(Array.from(column.features[1]!.values)).toEqual([1, 0, 0]);
  });

  it('目的メトリクスが欠損・NaN の Run を除外して数を返す', () => {
    const matrix = buildParameterMatrix({
      runs: [
        { parameters: { a: 1 }, metrics: { loss: 1 } },
        { parameters: { a: 2 }, metrics: {} },
        { parameters: { a: 3 }, metrics: { loss: Number.NaN } },
        { parameters: { a: 4 }, metrics: { loss: null } },
      ],
      objectiveMetric: 'loss',
      parameterNames: ['a'],
    });
    expect(matrix.runCount).toBe(1);
    expect(matrix.skippedRunCount).toBe(3);
  });

  it('数値列の欠損は平均で埋めず NaN のまま残し、欠損フラグ列と coverage を足す', () => {
    const matrix = buildParameterMatrix({
      runs: [
        { parameters: { a: 1 }, metrics: { loss: 1 } },
        { parameters: {}, metrics: { loss: 2 } },
        { parameters: { a: null }, metrics: { loss: 3 } },
        { parameters: { a: '4' }, metrics: { loss: 4 } },
      ],
      objectiveMetric: 'loss',
      parameterNames: ['a'],
    });
    const column = matrix.columns[0]!;
    expect(column.coverage).toBe(0.5);
    expect(column.features.map((feature) => feature.kind)).toEqual(['numeric', 'missing_flag']);
    expect(Array.from(column.features[0]!.values)).toEqual([1, Number.NaN, Number.NaN, 4]);
    expect(Array.from(column.features[1]!.values)).toEqual([0, 1, 1, 0]);
  });

  it('欠損の無い数値列には欠損フラグ列を足さない', () => {
    const matrix = buildParameterMatrix({
      runs: [{ parameters: { a: 1 }, metrics: { loss: 1 } }],
      objectiveMetric: 'loss',
      parameterNames: ['a'],
    });
    expect(matrix.columns[0]!.features).toHaveLength(1);
  });

  it('水準が上限を超えるカテゴリ列と、値が1つも無い列を理由付きで除外する', () => {
    const runs = Array.from({ length: MAX_CATEGORY_LEVELS + 1 }, (_, index) => ({
      parameters: { runName: `run-${index}`, kept: index % 2 === 0 ? 'a' : 'b' },
      metrics: { loss: index },
    }));
    const matrix = buildParameterMatrix({ runs, objectiveMetric: 'loss', parameterNames: ['runName', 'absent', 'kept'] });
    expect(matrix.columns.map((column) => column.param)).toEqual(['kept']);
    expect(matrix.excluded).toEqual([
      { param: 'runName', reason: 'high_cardinality' },
      { param: 'absent', reason: 'no_values' },
    ]);
  });

  it('真偽値と JSON の値はカテゴリの水準として扱う', () => {
    const matrix = buildParameterMatrix({
      runs: [
        { parameters: { flag: true, layers: [1, 2] }, metrics: { loss: 1 } },
        { parameters: { flag: false, layers: [3] }, metrics: { loss: 2 } },
      ],
      objectiveMetric: 'loss',
      parameterNames: ['flag', 'layers'],
    });
    expect(matrix.columns.map((column) => column.kind)).toEqual(['categorical', 'categorical']);
    expect(matrix.columns[1]!.features.map((feature) => feature.level)).toEqual(['[1,2]', '[3]']);
  });
});

describe('collectParameterNames', () => {
  it('全 Run の parameter 名を重複なく名前順で返す', () => {
    expect(
      collectParameterNames([
        { parameters: { b: 1, a: 1 }, metrics: {} },
        { parameters: { c: 'x', a: 2 }, metrics: {} },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });
});
