import { countGridCombinations, gridValues, sortedParameterNames } from './searchSpace.js';
import type { SearchSpace, SuggestResult, TrialParameters } from './types.js';

/**
 * trialIndex 番目の組を返す。順は parameter 名の昇順×値の宣言順で、
 * 名前が先の parameter ほどゆっくり変わる（名前順に入れ子にした for と同じ）。
 * 全組を使い切ったら exhausted。探索空間は validateSearchSpace(space, 'grid') 済みであること。
 */
export function suggestGrid(space: SearchSpace, trialIndex: number): SuggestResult {
  if (trialIndex >= countGridCombinations(space)) return { exhausted: true };
  const names = sortedParameterNames(space);
  const parameters: TrialParameters = {};
  let remainder = trialIndex;
  for (let position = names.length - 1; position >= 0; position -= 1) {
    const name = names[position]!;
    const values = gridValues(space[name]!);
    parameters[name] = values[remainder % values.length]!;
    remainder = Math.floor(remainder / values.length);
  }
  return { parameters: Object.fromEntries(names.map((name) => [name, parameters[name]!])) };
}
