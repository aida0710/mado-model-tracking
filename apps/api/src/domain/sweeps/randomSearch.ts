import { createSeededRandom, deriveSeed } from '../seededRandom.js';
import { sampleParameter } from './parameterSampling.js';
import { sortedParameterNames } from './searchSpace.js';
import type { SearchSpace, SuggestResult, TrialParameters } from './types.js';

/**
 * 各 parameter を分布から独立に引く。乱数は seed と trialIndex だけから決めるので、
 * 同じ seed・trialIndex なら完了試行の有無に関係なく同じ値になる。random は使い切らない。
 */
export function suggestRandom(space: SearchSpace, seed: number, trialIndex: number): SuggestResult {
  const random = createSeededRandom(deriveSeed(seed, trialIndex));
  const parameters: TrialParameters = {};
  for (const name of sortedParameterNames(space)) parameters[name] = sampleParameter(space[name]!, random);
  return { parameters };
}
