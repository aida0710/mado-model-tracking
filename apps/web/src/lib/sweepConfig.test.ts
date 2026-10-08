import { describe, expect, it } from 'vitest';
import {
  SweepConfigError,
  convertWandbSweepConfig,
  countGridCombinations,
  createSearchSpaceRow,
  formatParameterValues,
  parseParameterValues,
  rowIdForSpaceError,
  rowsToSearchSpace,
  searchSpaceToRows,
  toWandbSweepConfig,
  type SearchSpaceRow,
} from './sweepConfig';

const minimalConfig = {
  method: 'random',
  metric: { name: 'val_loss', goal: 'minimize' },
  parameters: { lr: { values: [0.1, 0.01] } },
  run_cap: 4,
};

function row(change: Partial<SearchSpaceRow>, id = 'row'): SearchSpaceRow {
  return { ...createSearchSpaceRow(id), ...change };
}

describe('W&B形式のsweep configの変換', () => {
  it('bayesとearly_terminateをAPIの形に変換する（docs/sweeps.mdの例）', () => {
    expect(
      convertWandbSweepConfig({
        method: 'bayes',
        metric: { name: 'val_loss', goal: 'minimize', aggregation: 'min' },
        parameters: {
          lr: { distribution: 'log_uniform_values', min: 1e-5, max: 1e-2 },
          batch_size: { values: [16, 32, 64] },
          epochs: { value: 10 },
          dropout: { distribution: 'q_uniform', min: 0, max: 0.5, q: 0.1 },
        },
        early_terminate: { type: 'hyperband', min_iter: 1, eta: 3, max_iter: 27 },
        run_cap: 30,
        parallelism: 4,
      }),
    ).toEqual({
      method: 'bayes',
      objective: { metric: 'val_loss', goal: 'minimize', aggregation: 'min' },
      searchSpace: {
        lr: { distribution: 'log_uniform', min: 1e-5, max: 1e-2 },
        batch_size: { values: [16, 32, 64] },
        epochs: { value: 10 },
        dropout: { distribution: 'q_uniform', min: 0, max: 0.5, q: 0.1 },
      },
      earlyStopping: { type: 'hyperband', minIter: 1, eta: 3, maxIter: 27 },
      maxTrials: 30,
      parallelism: 4,
    });
  });

  it('gridのcategorical・constantを変換し、省略したparallelismとaggregationは送らない', () => {
    const settings = convertWandbSweepConfig({
      method: 'grid',
      metric: { name: 'accuracy', goal: 'maximize' },
      parameters: {
        optimizer: { distribution: 'categorical', values: ['adam', 'sgd'] },
        seed: { distribution: 'constant', value: 7 },
      },
      run_cap: 2,
    });
    expect(settings).toEqual({
      method: 'grid',
      objective: { metric: 'accuracy', goal: 'maximize' },
      searchSpace: { optimizer: { values: ['adam', 'sgd'] }, seed: { value: 7 } },
      maxTrials: 2,
    });
  });

  it('distributionを省略したmin/maxは両方整数ならint_uniform、それ以外はuniformにする', () => {
    const { searchSpace } = convertWandbSweepConfig({
      ...minimalConfig,
      parameters: { layers: { min: 1, max: 8 }, dropout: { min: 0, max: 0.5 } },
    });
    expect(searchSpace).toEqual({
      layers: { distribution: 'int_uniform', min: 1, max: 8 },
      dropout: { distribution: 'uniform', min: 0, max: 0.5 },
    });
  });

  it('early_terminateのetaを省略するとW&Bの既定3になる', () => {
    expect(
      convertWandbSweepConfig({ ...minimalConfig, early_terminate: { type: 'hyperband', min_iter: 2 } }).earlyStopping,
    ).toEqual({ type: 'hyperband', minIter: 2, eta: 3 });
  });

  it.each([
    ['トップレベルのprogram', { ...minimalConfig, program: 'train.py' }, 'program'],
    ['metric.target', { ...minimalConfig, metric: { name: 'loss', goal: 'minimize', target: 0.1 } }, 'target'],
    ['categoricalのprobabilities', { ...minimalConfig, parameters: { lr: { values: [1, 2], probabilities: [0.5, 0.5] } } }, 'probabilities'],
    ['q_uniform以外のq', { ...minimalConfig, parameters: { lr: { distribution: 'uniform', min: 0, max: 1, q: 0.1 } } }, 'q'],
    ['hyperbandのs', { ...minimalConfig, early_terminate: { type: 'hyperband', min_iter: 1, s: 2 } }, 's'],
    ['hyperbandのstrict', { ...minimalConfig, early_terminate: { type: 'hyperband', min_iter: 1, strict: true } }, 'strict'],
  ])('未対応のキー（%s）は黙って捨てずエラーにする', (_label, config, key) => {
    expect(() => convertWandbSweepConfig(config)).toThrowError(SweepConfigError);
    expect(() => convertWandbSweepConfig(config)).toThrowError(new RegExp(`未対応のキー: ${key}`));
  });

  it.each([
    ['W&Bのlog_uniform（指数を渡す）', { lr: { distribution: 'log_uniform', min: -5, max: -2 } }, 'log_uniform_values'],
    ['normal分布', { lr: { distribution: 'normal', mu: 0, sigma: 1 } }, 'normal'],
    ['入れ子のparameters', { optimizer: { parameters: { lr: { values: [1] } } } }, '入れ子'],
    ['valuesでもvalueでも範囲でもない', { lr: { foo: 1 } }, 'values、value、またはminとmax'],
  ])('%sはエラーにする', (_label, parameters, message) => {
    expect(() => convertWandbSweepConfig({ ...minimalConfig, parameters })).toThrowError(message);
  });

  it.each([
    ['run_capが無い', { ...minimalConfig, run_cap: undefined }],
    ['run_capが0', { ...minimalConfig, run_cap: 0 }],
    ['methodが未知', { ...minimalConfig, method: 'hyperopt' }],
    ['goalが未知', { ...minimalConfig, metric: { name: 'loss', goal: 'lower' } }],
    ['metric.nameが空', { ...minimalConfig, metric: { name: ' ', goal: 'minimize' } }],
    ['parametersが空', { ...minimalConfig, parameters: {} }],
    ['configが配列', []],
  ])('必須の値の誤り（%s）はエラーにする', (_label, config) => {
    const normalized = JSON.parse(JSON.stringify(config)) as unknown;
    expect(() => convertWandbSweepConfig(normalized)).toThrowError(SweepConfigError);
  });

  it('APIの形からW&B形式に戻すと同じ設定に変換し直せる', () => {
    const settings = convertWandbSweepConfig({
      method: 'bayes',
      metric: { name: 'val_loss', goal: 'minimize', aggregation: 'last' },
      parameters: {
        lr: { distribution: 'log_uniform_values', min: 0.0001, max: 0.1 },
        layers: { distribution: 'int_uniform', min: 1, max: 4 },
        optimizer: { values: ['adam', 'sgd'] },
      },
      early_terminate: { type: 'hyperband', min_iter: 1, eta: 2 },
      run_cap: 8,
      parallelism: 2,
    });
    const config = toWandbSweepConfig(settings);
    expect(config.parameters).toMatchObject({ lr: { distribution: 'log_uniform_values' } });
    expect(convertWandbSweepConfig(config)).toEqual(settings);
  });
});

describe('gridの組み合わせ数', () => {
  it('valuesの個数の積を返し、定数は1通りとして数える', () => {
    expect(countGridCombinations({ a: { values: [1, 2] }, b: { values: ['x', 'y', 'z'] }, c: { value: 1 } })).toBe(6);
  });
  it('範囲のparameterがあると列挙できないのでnullを返す', () => {
    expect(countGridCombinations({ a: { values: [1, 2] }, b: { distribution: 'uniform', min: 0, max: 1 } })).toBeNull();
  });
});

describe('探索空間の行', () => {
  it('カンマ区切りの値は数値・真偽値・文字列の型を保って読む', () => {
    expect(parseParameterValues('0.1, 1e-3, true, adam, "32"')).toEqual([0.1, 0.001, true, 'adam', '32']);
  });
  it('カンマを含む値はJSON配列で書き、書いた値をそのまま読み戻せる', () => {
    const values = ['a,b', 'c', '1'];
    expect(formatParameterValues(values)).toBe('["a,b","c","1"]');
    expect(parseParameterValues(formatParameterValues(values))).toEqual(values);
    expect(formatParameterValues([16, 32])).toBe('16, 32');
  });

  it('行から探索空間を作り、範囲・値・定数をAPIの形にする', () => {
    const result = rowsToSearchSpace(
      [
        row({ name: 'lr', kind: 'range', distribution: 'log_uniform', min: '0.0001', max: '0.1' }, 'a'),
        row({ name: 'batch_size', kind: 'values', values: '16, 32' }, 'b'),
        row({ name: 'epochs', kind: 'constant', value: '3' }, 'c'),
        row({ name: 'step', kind: 'range', distribution: 'q_uniform', min: '0', max: '1', q: '0.25' }, 'd'),
      ],
      'random',
    );
    expect(result.rowErrors).toEqual({});
    expect(result.searchSpace).toEqual({
      lr: { distribution: 'log_uniform', min: 0.0001, max: 0.1 },
      batch_size: { values: [16, 32] },
      epochs: { value: 3 },
      step: { distribution: 'q_uniform', min: 0, max: 1, q: 0.25 },
    });
  });

  it('名前の空・重複、値の空、数値でないmin、gridの範囲はその行のエラーになる', () => {
    const { rowErrors, searchSpace } = rowsToSearchSpace(
      [
        row({ name: '', values: '1' }, 'empty-name'),
        row({ name: 'a', values: '1' }, 'first'),
        row({ name: 'a', values: '2' }, 'duplicate'),
        row({ name: 'b', values: ' ' }, 'no-values'),
        row({ name: 'c', kind: 'range', min: 'x', max: '1' }, 'bad-min'),
      ],
      'random',
    );
    expect(Object.keys(rowErrors).sort()).toEqual(['bad-min', 'duplicate', 'empty-name', 'no-values']);
    expect(searchSpace).toEqual({ a: { values: [1] } });
    expect(rowsToSearchSpace([row({ name: 'lr', kind: 'range', min: '0', max: '1' }, 'range')], 'grid').rowErrors)
      .toHaveProperty('range');
  });

  it('探索空間を行にして戻すと同じ探索空間になる', () => {
    const space = {
      lr: { distribution: 'log_uniform' as const, min: 0.001, max: 0.1 },
      optimizer: { values: ['adam', '1'] },
      flag: { value: true },
    };
    let id = 0;
    expect(rowsToSearchSpace(searchSpaceToRows(space, () => `row-${id++}`), 'random').searchSpace).toEqual(space);
  });

  it('APIの422のmessageが「名前」で指すparameterの行を返し、指さないmessageはnullを返す', () => {
    const rows = [row({ name: 'lr' }, 'lr-row'), row({ name: 'batch' }, 'batch-row')];
    expect(rowIdForSpaceError('parameter「batch」は min < max である必要があります（min=2, max=1）', rows)).toBe('batch-row');
    expect(rowIdForSpaceError('grid の組み合わせ数は10000までです（20000通り）', rows)).toBeNull();
  });
});
