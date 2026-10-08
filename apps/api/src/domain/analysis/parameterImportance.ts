import { DomainError } from '../errors.js';
import { parameterCorrelation } from './correlation.js';
import {
  buildParameterMatrix,
  collectParameterNames,
  type ParameterAnalysisRun,
  type ParameterExclusion,
  type ParameterKind,
} from './parameterMatrix.js';
import { computeRandomForestImportance } from './randomForest.js';

/** これより少ない Run の重要度は木がほぼ分割できず、偶然の差を「効いている」と誤解させるので出さない。 */
export const IMPORTANCE_MIN_RUNS = 5;
/**
 * 入力の上限。ランダムフォレストの計算量は Run 数 × parameter 数にほぼ比例し、
 * この組み合わせで API の1リクエスト内（目安3秒）に収まる。
 */
export const MAX_IMPORTANCE_RUNS = 5000;
export const MAX_IMPORTANCE_PARAMETERS = 100;
/** seed を指定しないときの既定値。同じ入力なら毎回同じ重要度を返すため固定する。 */
export const DEFAULT_IMPORTANCE_SEED = 1;

export interface ParameterImportanceEntry {
  param: string;
  kind: ParameterKind;
  correlation: number | null;
  /** 分散減少による重要度（全 parameter で合計1）。Run が少ないときは null。 */
  importance: number | null;
  /** out-of-bag の permutation importance（R² の低下）。Run が少ないときは null。 */
  permutationImportance: number | null;
  coverage: number;
}

export type ImportanceUnavailableReason = 'too_few_runs';

export interface ParameterImportanceResult {
  objectiveMetric: string;
  /** 目的メトリクスがあり計算に使った Run の数。 */
  runCount: number;
  /** 目的メトリクスが欠損・非有限で除外した Run の数。 */
  skippedRunCount: number;
  /** importance の大きい順（null のときは相関の絶対値の大きい順）。 */
  entries: ParameterImportanceEntry[];
  excluded: ParameterExclusion[];
  importanceUnavailableReason: ImportanceUnavailableReason | null;
  /** フォレストの out-of-bag R²。重要度をどこまで信じてよいかの目安。 */
  outOfBagR2: number | null;
}

export function computeParameterImportance(input: {
  runs: ParameterAnalysisRun[];
  objectiveMetric: string;
  /** 省略すると、入力に現れた全ての parameter を対象にする。 */
  parameterNames?: string[];
  seed?: number;
}): ParameterImportanceResult {
  if (input.runs.length > MAX_IMPORTANCE_RUNS) {
    throw new DomainError(422, `重要度の計算に使える Run は ${MAX_IMPORTANCE_RUNS} 件までです`, 'too_many_runs');
  }
  const parameterNames = input.parameterNames ?? collectParameterNames(input.runs);
  if (parameterNames.length > MAX_IMPORTANCE_PARAMETERS) {
    throw new DomainError(
      422,
      `重要度の計算に使える parameter は ${MAX_IMPORTANCE_PARAMETERS} 個までです`,
      'too_many_parameters',
    );
  }

  const matrix = buildParameterMatrix({ runs: input.runs, objectiveMetric: input.objectiveMetric, parameterNames });
  const hasEnoughRuns = matrix.runCount >= IMPORTANCE_MIN_RUNS;
  const forest =
    hasEnoughRuns && matrix.columns.length > 0
      ? computeRandomForestImportance({
          features: matrix.columns.flatMap((column) => column.features.map((feature) => feature.values)),
          featureGroups: matrix.columns.flatMap((column, columnIndex) => column.features.map(() => columnIndex)),
          groupCount: matrix.columns.length,
          target: matrix.objective,
          seed: input.seed ?? DEFAULT_IMPORTANCE_SEED,
        })
      : null;

  const entries = matrix.columns.map(
    (column, columnIndex): ParameterImportanceEntry => ({
      param: column.param,
      kind: column.kind,
      correlation: parameterCorrelation(column, matrix.objective),
      importance: forest ? forest.impurityImportance[columnIndex]! : null,
      permutationImportance: forest ? forest.permutationImportance[columnIndex]! : null,
      coverage: column.coverage,
    }),
  );

  return {
    objectiveMetric: input.objectiveMetric,
    runCount: matrix.runCount,
    skippedRunCount: matrix.skippedRunCount,
    entries: entries.sort(compareEntries),
    excluded: matrix.excluded,
    importanceUnavailableReason: hasEnoughRuns ? null : 'too_few_runs',
    outOfBagR2: forest?.outOfBagR2 ?? null,
  };
}

function compareEntries(left: ParameterImportanceEntry, right: ParameterImportanceEntry): number {
  const byImportance = (right.importance ?? 0) - (left.importance ?? 0);
  if (byImportance !== 0) return byImportance;
  const byCorrelation = Math.abs(right.correlation ?? 0) - Math.abs(left.correlation ?? 0);
  if (byCorrelation !== 0) return byCorrelation;
  // localeCompare は実行環境のロケールで順序が変わるので、コード単位で比べる。
  return left.param < right.param ? -1 : left.param > right.param ? 1 : 0;
}
