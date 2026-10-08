import { describe, expect, it } from 'vitest';
import { createSeededRandom, deriveSeed } from '../seededRandom.js';
import { BAYES_STARTUP_TRIALS, suggestBayes } from './bayesSearch.js';
import { suggestGrid } from './gridSearch.js';
import { suggestRandom } from './randomSearch.js';
import { suggestTrial } from './suggestTrial.js';
import type { CompletedTrial, SearchSpace, SuggestInput, SuggestResult, TrialParameters } from './types.js';

function parametersOf(result: SuggestResult): TrialParameters {
  if ('exhausted' in result) throw new Error('提案が使い切られています');
  return result.parameters;
}

function randomValues(space: SearchSpace, seed: number, count: number, name: string): number[] {
  return Array.from({ length: count }, (_, trialIndex) => parametersOf(suggestRandom(space, seed, trialIndex))[name] as number);
}

describe('createSeededRandom', () => {
  it('同じ seed なら同じ列、違う seed なら違う列になる', () => {
    const draw = (seed: number) => {
      const random = createSeededRandom(seed);
      return Array.from({ length: 5 }, () => random.next());
    };
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
  });

  it('next は [0,1)、nextInt は両端を含む範囲、nextGaussian は平均0・分散1に近い', () => {
    const random = createSeededRandom(7);
    const ints = new Set<number>();
    let sum = 0;
    let squares = 0;
    const count = 5000;
    for (let index = 0; index < count; index += 1) {
      const value = random.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      ints.add(random.nextInt(2, 4));
      const gaussian = random.nextGaussian();
      sum += gaussian;
      squares += gaussian * gaussian;
    }
    expect([...ints].sort()).toEqual([2, 3, 4]);
    expect(Math.abs(sum / count)).toBeLessThan(0.05);
    expect(Math.abs(squares / count - 1)).toBeLessThan(0.1);
  });

  it('deriveSeed は系列番号ごとに別の seed を返す', () => {
    const seeds = new Set(Array.from({ length: 100 }, (_, stream) => deriveSeed(1, stream)));
    expect(seeds.size).toBe(100);
  });
});

describe('grid', () => {
  const space: SearchSpace = { optimizer: { values: ['adam', 'sgd'] }, batch: { values: [16, 32, 64] }, epochs: { value: 5 } };

  it('全組を重複なく決まった順で列挙し、最後に exhausted を返す', () => {
    const combinations = Array.from({ length: 6 }, (_, trialIndex) => parametersOf(suggestGrid(space, trialIndex)));
    expect(new Set(combinations.map((parameters) => JSON.stringify(parameters))).size).toBe(6);
    // 名前の昇順（batch, epochs, optimizer）で、先の名前ほどゆっくり変わる。
    expect(combinations.slice(0, 3)).toEqual([
      { batch: 16, epochs: 5, optimizer: 'adam' },
      { batch: 16, epochs: 5, optimizer: 'sgd' },
      { batch: 32, epochs: 5, optimizer: 'adam' },
    ]);
    expect(suggestGrid(space, 6)).toEqual({ exhausted: true });
  });
});

describe('random', () => {
  const space: SearchSpace = {
    dropout: { distribution: 'uniform', min: 0.1, max: 0.5 },
    lr: { distribution: 'log_uniform', min: 1e-3, max: 1e3 },
    layers: { distribution: 'int_uniform', min: 1, max: 4 },
    batch: { distribution: 'q_uniform', min: 0.1, max: 1, q: 0.2 },
    optimizer: { values: ['adam', 'sgd'] },
    epochs: { value: 3 },
  };

  it('同じ seed・trialIndex なら同じ値、seed が違えば違う値になる', () => {
    expect(suggestRandom(space, 11, 4)).toEqual(suggestRandom(space, 11, 4));
    expect(suggestRandom(space, 11, 4)).not.toEqual(suggestRandom(space, 12, 4));
    expect(suggestRandom(space, 11, 4)).not.toEqual(suggestRandom(space, 11, 5));
  });

  it('各分布の範囲・整数・q 刻みを守る', () => {
    for (let trialIndex = 0; trialIndex < 500; trialIndex += 1) {
      const parameters = parametersOf(suggestRandom(space, 3, trialIndex));
      const dropout = parameters.dropout as number;
      expect(dropout).toBeGreaterThanOrEqual(0.1);
      expect(dropout).toBeLessThanOrEqual(0.5);
      expect([1, 2, 3, 4]).toContain(parameters.layers);
      expect([0.1, 0.3, 0.5, 0.7, 0.9]).toContain(parameters.batch);
      expect(['adam', 'sgd']).toContain(parameters.optimizer);
      expect(parameters.epochs).toBe(3);
    }
  });

  it('int_uniform は両端の値も出る', () => {
    expect(new Set(randomValues(space, 5, 200, 'layers'))).toEqual(new Set([1, 2, 3, 4]));
  });

  it('log_uniform は対数が一様に分布する（KS 統計量の粗い検定）', () => {
    const count = 2000;
    const positions = randomValues(space, 9, count, 'lr')
      .map((value) => (Math.log(value) - Math.log(1e-3)) / (Math.log(1e3) - Math.log(1e-3)))
      .sort((left, right) => left - right);
    const ksStatistic = positions.reduce(
      (largest, position, index) => Math.max(largest, Math.abs(position - index / count), Math.abs(position - (index + 1) / count)),
      0,
    );
    // 有意水準1%の臨界値 1.63/sqrt(n) ≒ 0.036
    expect(ksStatistic).toBeLessThan(0.036);
  });
});

describe('bayes（TPE）', () => {
  const space: SearchSpace = { x: { distribution: 'uniform', min: 0, max: 1 } };
  const objectiveOf = (parameters: TrialParameters) => ((parameters.x as number) - 0.3) ** 2;

  function runSweep(method: 'random' | 'bayes', seed: number, trialCount: number): number {
    const completedTrials: CompletedTrial[] = [];
    for (let trialIndex = 0; trialIndex < trialCount; trialIndex += 1) {
      const parameters = parametersOf(
        suggestTrial({ space, method, goal: 'minimize', seed, trialIndex, completedTrials, pendingParameters: [] }),
      );
      completedTrials.push({ parameters, objective: objectiveOf(parameters), state: 'finished' });
    }
    return Math.min(...completedTrials.map((trial) => trial.objective!));
  }

  function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2;
  }

  it('(x-0.3)^2 の最小化で、同じ試行数の random より最良値の中央値が良い（seed 20本）', () => {
    const seeds = Array.from({ length: 20 }, (_, seed) => seed);
    const bayesBest = median(seeds.map((seed) => runSweep('bayes', seed, 30)));
    const randomBest = median(seeds.map((seed) => runSweep('random', seed, 30)));
    expect(bayesBest).toBeLessThan(randomBest);
  });

  it('使える完了試行が10件未満なら random と同じ値を返す', () => {
    const completedTrials: CompletedTrial[] = Array.from({ length: BAYES_STARTUP_TRIALS - 1 }, (_, index) => ({
      parameters: { x: index / 10 },
      objective: index,
      state: 'finished',
    }));
    // failed は数に入らないので、10件あっても random のまま。
    completedTrials.push({ parameters: { x: 0.5 }, objective: 1, state: 'failed' });
    const input: SuggestInput = { space, method: 'bayes', goal: 'minimize', seed: 4, trialIndex: 10, completedTrials, pendingParameters: [] };
    expect(suggestBayes(input)).toEqual(suggestRandom(space, 4, 10));
  });

  it('完了試行が10件以上になると良い試行の近くを提案し、同じ入力なら同じ値になる', () => {
    const completedTrials: CompletedTrial[] = Array.from({ length: 20 }, (_, index) => {
      const x = index / 19;
      return { parameters: { x }, objective: (x - 0.3) ** 2, state: index % 7 === 0 ? 'early_stopped' : 'finished' };
    });
    const input: SuggestInput = { space, method: 'bayes', goal: 'minimize', seed: 1, trialIndex: 20, completedTrials, pendingParameters: [] };
    const suggested = parametersOf(suggestBayes(input)).x as number;
    expect(Math.abs(suggested - 0.3)).toBeLessThan(0.2);
    expect(suggestBayes(input)).toEqual(suggestBayes(input));
    // maximize にすると良い試行が逆になり、0.3 から離れた端を提案する。
    const farthest = parametersOf(suggestBayes({ ...input, goal: 'maximize' })).x as number;
    expect(Math.abs(farthest - 0.3)).toBeGreaterThan(0.4);
  });

  it('categorical・log_uniform・整数を含む空間でも定義どおりの値を返す', () => {
    const mixedSpace: SearchSpace = {
      optimizer: { values: ['adam', 'sgd', 'rmsprop'] },
      lr: { distribution: 'log_uniform', min: 1e-5, max: 1e-1 },
      layers: { distribution: 'int_uniform', min: 1, max: 6 },
      batch: { distribution: 'q_uniform', min: 16, max: 128, q: 16 },
      epochs: { value: 2 },
    };
    const completedTrials: CompletedTrial[] = Array.from({ length: 15 }, (_, trialIndex) => {
      const parameters = parametersOf(suggestRandom(mixedSpace, 2, trialIndex));
      const objective = parameters.optimizer === 'sgd' ? 0.1 : 1;
      return { parameters, objective, state: 'finished' };
    });
    const suggestions = Array.from({ length: 20 }, (_, offset) =>
      parametersOf(
        suggestBayes({ space: mixedSpace, method: 'bayes', goal: 'minimize', seed: 2, trialIndex: 15 + offset, completedTrials, pendingParameters: [] }),
      ),
    );
    for (const parameters of suggestions) {
      expect(parameters.lr as number).toBeGreaterThanOrEqual(1e-5);
      expect(parameters.lr as number).toBeLessThanOrEqual(1e-1);
      expect([1, 2, 3, 4, 5, 6]).toContain(parameters.layers);
      expect([16, 32, 48, 64, 80, 96, 112, 128]).toContain(parameters.batch);
      expect(parameters.epochs).toBe(2);
    }
    // 良い試行がすべて sgd なので、sgd を多く提案する。
    expect(suggestions.filter((parameters) => parameters.optimizer === 'sgd').length).toBeGreaterThan(10);
  });
});

describe('suggestTrial', () => {
  it('探索空間を検証し、grid に連続分布を渡すと拒否する', () => {
    expect(() =>
      suggestTrial({
        space: { x: { distribution: 'uniform', min: 0, max: 1 } },
        method: 'grid',
        goal: 'minimize',
        seed: 0,
        trialIndex: 0,
        completedTrials: [],
        pendingParameters: [],
      }),
    ).toThrow('連続分布: x');
  });
});
