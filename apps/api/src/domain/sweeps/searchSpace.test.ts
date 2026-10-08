import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors.js';
import { MAX_CATEGORICAL_VALUES, MAX_GRID_COMBINATIONS, MAX_SWEEP_PARAMETERS, validateSearchSpace } from './searchSpace.js';
import type { SearchSpace, SweepMethod } from './types.js';

function rejection(space: SearchSpace, method: SweepMethod = 'random'): DomainError {
  try {
    validateSearchSpace(space, method);
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('検証が通ってしまいました');
}

describe('validateSearchSpace', () => {
  it('categorical・constant・各分布を混ぜた空間を random と bayes で受け付ける', () => {
    const space: SearchSpace = {
      optimizer: { values: ['adam', 'sgd'] },
      epochs: { value: 10 },
      lr: { distribution: 'log_uniform', min: 1e-5, max: 1e-1 },
      dropout: { distribution: 'uniform', min: 0, max: 0.5 },
      layers: { distribution: 'int_uniform', min: 1, max: 8 },
      batch: { distribution: 'q_uniform', min: 16, max: 256, q: 16 },
    };
    expect(() => validateSearchSpace(space, 'random')).not.toThrow();
    expect(() => validateSearchSpace(space, 'bayes')).not.toThrow();
  });

  it('違反は 422 sweep_space_invalid で、message に該当する parameter 名が入る', () => {
    const error = rejection({ lr: { distribution: 'uniform', min: 1, max: 1 } });
    expect(error.status).toBe(422);
    expect(error.code).toBe('sweep_space_invalid');
    expect(error.message).toContain('「lr」');
    expect(error.message).toContain('min < max');
  });

  it.each<[string, SearchSpace, string]>([
    ['parameter が無い', {}, 'parameter が1つもありません'],
    ['values が空', { a: { values: [] } }, '「a」の values が空'],
    ['values が重複', { a: { values: [1, 2, 1] } }, '重複した値 1'],
    ['values に NaN', { a: { values: [Number.NaN] } }, '「a」の values には'],
    ['log_uniform で min が0', { lr: { distribution: 'log_uniform', min: 0, max: 1 } }, '「lr」は log_uniform なので min > 0'],
    ['int_uniform で小数', { n: { distribution: 'int_uniform', min: 0.5, max: 3 } }, '「n」は int_uniform なので'],
    ['q を uniform に指定', { x: { distribution: 'uniform', min: 0, max: 1, q: 0.1 } }, '「x」の q は q_uniform のときだけ'],
    ['q が0', { x: { distribution: 'q_uniform', min: 0, max: 1, q: 0 } }, '「x」の q は正の数'],
    ['min が無限大', { x: { distribution: 'uniform', min: -Infinity, max: 1 } }, '「x」の min と max には有限の数値'],
    ['values と distribution の両方', { x: { values: [1], distribution: 'uniform', min: 0, max: 1 } as never }, '「x」には values・value・distribution のどれか1つだけ'],
    ['未知の distribution', { x: { distribution: 'normal', min: 0, max: 1 } as never }, '「x」の distribution「normal」は使えません'],
  ])('%s を拒否する', (_label, space, message) => {
    expect(rejection(space).message).toContain(message);
  });

  it('parameter 数と categorical の値数の上限を超えると拒否する', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_SWEEP_PARAMETERS + 1 }, (_, index) => [`p${index}`, { value: index }]),
    );
    expect(rejection(tooMany).message).toContain(`${MAX_SWEEP_PARAMETERS}個まで`);
    const manyValues = { a: { values: Array.from({ length: MAX_CATEGORICAL_VALUES + 1 }, (_, index) => index) } };
    expect(rejection(manyValues).message).toContain(`「a」の values は${MAX_CATEGORICAL_VALUES}個まで`);
  });

  it('grid は連続分布の parameter を拒否し、どの parameter かを示す', () => {
    const error = rejection(
      { a: { values: [1, 2] }, lr: { distribution: 'uniform', min: 0, max: 1 } },
      'grid',
    );
    expect(error.message).toContain('連続分布: lr');
  });

  it('grid の組み合わせ数が上限ちょうどなら受け付け、超えると拒否する', () => {
    const values = (count: number) => ({ values: Array.from({ length: count }, (_, index) => index) });
    expect(() => validateSearchSpace({ a: values(100), b: values(100) }, 'grid')).not.toThrow();
    const error = rejection({ a: values(100), b: values(100), c: values(2) }, 'grid');
    expect(error.message).toContain(`${MAX_GRID_COMBINATIONS}まで`);
    expect(error.message).toContain('20000通り');
  });
});
