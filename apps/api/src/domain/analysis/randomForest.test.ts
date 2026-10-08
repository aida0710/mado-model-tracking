import { describe, expect, it } from 'vitest';
import { createSeededRandom } from '../seededRandom.js';
import { computeRandomForestImportance } from './randomForest.js';

function syntheticFeatures(runCount: number, seed: number) {
  const random = createSeededRandom(seed);
  const signal = Float64Array.from({ length: runCount }, () => random.next());
  const noise = Float64Array.from({ length: runCount }, () => random.next());
  const target = Float64Array.from(signal, (value) => 3 * value + 0.1 * random.nextGaussian());
  return { signal, noise, target };
}

describe('computeRandomForestImportance', () => {
  it('目的値を決める列に重要度が集まり、impurity の重要度は合計1になる', () => {
    const { signal, noise, target } = syntheticFeatures(300, 7);
    const result = computeRandomForestImportance({
      features: [signal, noise],
      featureGroups: [0, 1],
      groupCount: 2,
      target,
      seed: 1,
    });
    expect(result.impurityImportance[0]!).toBeGreaterThan(0.8);
    expect(result.impurityImportance[0]! + result.impurityImportance[1]!).toBeCloseTo(1);
    expect(result.permutationImportance[0]!).toBeGreaterThan(result.permutationImportance[1]! + 0.5);
    expect(result.outOfBagR2!).toBeGreaterThan(0.9);
  });

  it('同じグループの列の重要度は1つにまとめて返す', () => {
    const { signal, noise, target } = syntheticFeatures(200, 3);
    const result = computeRandomForestImportance({
      features: [signal, noise, noise],
      featureGroups: [0, 1, 1],
      groupCount: 2,
      target,
      seed: 1,
    });
    expect(result.impurityImportance).toHaveLength(2);
    expect(result.permutationImportance).toHaveLength(2);
  });

  it('欠損（NaN）であること自体が目的値を決めるとき、その列に重要度が付く', () => {
    const random = createSeededRandom(11);
    const withMissing = Float64Array.from({ length: 200 }, (_, index) => (index % 2 === 0 ? Number.NaN : random.next()));
    const noise = Float64Array.from({ length: 200 }, () => random.next());
    const target = Float64Array.from(withMissing, (value) => (Number.isNaN(value) ? 10 : 0) + 0.1 * random.nextGaussian());
    const result = computeRandomForestImportance({
      features: [withMissing, noise],
      featureGroups: [0, 1],
      groupCount: 2,
      target,
      seed: 1,
    });
    expect(result.impurityImportance[0]!).toBeGreaterThan(0.9);
  });

  it('目的値が定数なら分割せず、重要度は全て0で R² は null になる', () => {
    const result = computeRandomForestImportance({
      features: [Float64Array.from([1, 2, 3, 4, 5, 6])],
      featureGroups: [0],
      groupCount: 1,
      target: Float64Array.from([0.3, 0.3, 0.3, 0.3, 0.3, 0.3]),
      seed: 1,
    });
    expect(result.impurityImportance).toEqual([0]);
    expect(result.permutationImportance).toEqual([0]);
    expect(result.outOfBagR2).toBeNull();
  });

  it('同じ seed なら同じ結果、違う seed なら permutation importance が変わる', () => {
    const { signal, noise, target } = syntheticFeatures(150, 5);
    const run = (seed: number) =>
      computeRandomForestImportance({ features: [signal, noise], featureGroups: [0, 1], groupCount: 2, target, seed });
    expect(run(42)).toEqual(run(42));
    expect(run(42).permutationImportance).not.toEqual(run(43).permutationImportance);
  });
});
