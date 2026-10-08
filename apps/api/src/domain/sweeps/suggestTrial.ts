import { suggestBayes } from './bayesSearch.js';
import { suggestGrid } from './gridSearch.js';
import { suggestRandom } from './randomSearch.js';
import { validateSearchSpace } from './searchSpace.js';
import type { SuggestInput, SuggestResult } from './types.js';

/** method に応じて次の試行の parameter を提案する。探索空間はここでも検証する */
export function suggestTrial(input: SuggestInput): SuggestResult {
  if (!Number.isInteger(input.trialIndex) || input.trialIndex < 0)
    throw new RangeError(`trialIndex は0以上の整数である必要があります（${input.trialIndex}）`);
  validateSearchSpace(input.space, input.method);
  switch (input.method) {
    case 'grid':
      return suggestGrid(input.space, input.trialIndex);
    case 'random':
      return suggestRandom(input.space, input.seed, input.trialIndex);
    case 'bayes':
      return suggestBayes(input);
  }
}
