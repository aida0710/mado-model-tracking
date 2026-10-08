import type { MetricPoint, SweepGoal } from './types.js';

/** 目的メトリクスの履歴を1つの値にまとめる方法。既定の last は W&B の summary（最後に記録した値）と同じ */
export type ObjectiveAggregation = 'last' | 'min' | 'max';

export const DEFAULT_OBJECTIVE_AGGREGATION: ObjectiveAggregation = 'last';

/**
 * 履歴から objective を求める。NaN・Infinity は記録されていないものとして扱い、前の値で補完しない。
 * last は step が最大の点（同じ step なら後に記録した点）の値で、それが NaN なら null。
 * min・max は有限の値だけから求め、1つも無ければ null。
 */
export function computeObjective(
  history: readonly MetricPoint[],
  aggregation: ObjectiveAggregation = DEFAULT_OBJECTIVE_AGGREGATION,
): number | null {
  if (aggregation === 'last') {
    let last: MetricPoint | undefined;
    for (const point of history) if (last === undefined || point.step >= last.step) last = point;
    return last !== undefined && Number.isFinite(last.value) ? last.value : null;
  }
  // 履歴は数十万点になりうるので、Math.min(...values) の引数展開は使わない。
  let extreme: number | null = null;
  for (const { value } of history) {
    if (!Number.isFinite(value)) continue;
    if (extreme === null || (aggregation === 'min' ? value < extreme : value > extreme)) extreme = value;
  }
  return extreme;
}

/** left が良ければ負、right が良ければ正。null（objective 無し）は常に最後 */
export function compareObjectives(goal: SweepGoal, left: number | null, right: number | null): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
  if (left === right) return 0;
  const leftIsBetter = goal === 'minimize' ? left < right : left > right;
  return leftIsBetter ? -1 : 1;
}

export interface ObjectiveTrial {
  trialIndex: number;
  objective: number | null;
}

/** 良い順に並べる比較関数。同値は trialIndex の小さい方を先にする */
export function compareTrialsByObjective(goal: SweepGoal) {
  return (left: ObjectiveTrial, right: ObjectiveTrial): number =>
    compareObjectives(goal, left.objective, right.objective) || left.trialIndex - right.trialIndex;
}

/** 最良の試行。objective を持つ試行が無ければ null */
export function selectBestTrial<T extends ObjectiveTrial>(trials: readonly T[], goal: SweepGoal): T | null {
  const compare = compareTrialsByObjective(goal);
  let best: T | null = null;
  for (const trial of trials) {
    if (trial.objective === null) continue;
    if (best === null || compare(trial, best) < 0) best = trial;
  }
  return best;
}
