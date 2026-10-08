import type { JsonValue } from '@mmt/contracts';

/** これを超える種類の値を持つカテゴリ列は one-hot が疎になりすぎ、重要度が意味を持たないので除外する。 */
export const MAX_CATEGORY_LEVELS = 50;

// MLflow の params は文字列で届くので、'0.001' や '1e-4' を数値として扱う。'0x10' や 'Infinity' は数値にしない。
export const NUMERIC_STRING_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export interface ParameterAnalysisRun {
  parameters: Record<string, JsonValue | undefined>;
  metrics: Record<string, number | null | undefined>;
}

export type ParameterKind = 'numeric' | 'categorical';

export type ParameterExclusionReason = 'high_cardinality' | 'no_values';

export interface ParameterExclusion {
  param: string;
  reason: ParameterExclusionReason;
}

/**
 * モデルに渡す1列。値が無い Run は NaN。
 * numeric は parameter の値、missing_flag は値が無ければ 1、category_level はその水準なら 1。
 */
export interface FeatureColumn {
  kind: 'numeric' | 'missing_flag' | 'category_level';
  level: string | null;
  values: Float64Array;
}

export interface ParameterColumn {
  param: string;
  kind: ParameterKind;
  /** 値がある Run の割合（目的メトリクスのある Run が分母）。 */
  coverage: number;
  features: FeatureColumn[];
}

export interface ParameterMatrix {
  runCount: number;
  /** 目的メトリクスが欠損・非有限で除外した Run の数。 */
  skippedRunCount: number;
  objective: Float64Array;
  columns: ParameterColumn[];
  excluded: ParameterExclusion[];
}

type ParameterCell = { kind: 'missing' } | { kind: 'number'; value: number } | { kind: 'text'; value: string };

export function buildParameterMatrix(input: {
  runs: ParameterAnalysisRun[];
  objectiveMetric: string;
  parameterNames: string[];
}): ParameterMatrix {
  const usableRuns = input.runs.filter((run) => isFiniteNumber(run.metrics[input.objectiveMetric]));
  const objective = Float64Array.from(usableRuns, (run) => run.metrics[input.objectiveMetric] as number);
  const columns: ParameterColumn[] = [];
  const excluded: ParameterExclusion[] = [];

  for (const param of input.parameterNames) {
    const cells = usableRuns.map((run) => readParameterCell(run.parameters[param]));
    const presentCount = cells.filter((cell) => cell.kind !== 'missing').length;
    if (presentCount === 0) {
      excluded.push({ param, reason: 'no_values' });
      continue;
    }
    const coverage = presentCount / usableRuns.length;
    if (cells.every((cell) => cell.kind !== 'text')) {
      columns.push({ param, kind: 'numeric', coverage, features: numericFeatures(cells) });
      continue;
    }
    const levels = [...new Set(cells.flatMap((cell) => (cell.kind === 'missing' ? [] : [String(cell.value)])))].sort();
    if (levels.length > MAX_CATEGORY_LEVELS) {
      excluded.push({ param, reason: 'high_cardinality' });
      continue;
    }
    columns.push({ param, kind: 'categorical', coverage, features: categoryFeatures(cells, levels) });
  }

  return {
    runCount: usableRuns.length,
    skippedRunCount: input.runs.length - usableRuns.length,
    objective,
    columns,
    excluded,
  };
}

/** 入力に現れた parameter 名を、結果が入力順に左右されないよう名前順で返す。 */
export function collectParameterNames(runs: ParameterAnalysisRun[]): string[] {
  const names = new Set<string>();
  for (const run of runs) {
    for (const [name, value] of Object.entries(run.parameters)) {
      if (value !== undefined) names.add(name);
    }
  }
  return [...names].sort();
}

function readParameterCell(value: JsonValue | undefined): ParameterCell {
  if (value === undefined || value === null) return { kind: 'missing' };
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'number', value } : { kind: 'missing' };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (NUMERIC_STRING_PATTERN.test(trimmed)) return { kind: 'number', value: Number(trimmed) };
    return { kind: 'text', value };
  }
  if (typeof value === 'boolean') return { kind: 'text', value: String(value) };
  return { kind: 'text', value: JSON.stringify(value) };
}

/** 欠損を平均などで埋めると「値が無かった」こと自体の効果が隠れるので、NaN のまま残して欠損フラグ列を足す。 */
function numericFeatures(cells: ParameterCell[]): FeatureColumn[] {
  const values = Float64Array.from(cells, (cell) => (cell.kind === 'number' ? cell.value : Number.NaN));
  const features: FeatureColumn[] = [{ kind: 'numeric', level: null, values }];
  if (cells.some((cell) => cell.kind === 'missing')) {
    const flags = Float64Array.from(cells, (cell) => (cell.kind === 'missing' ? 1 : 0));
    features.push({ kind: 'missing_flag', level: null, values: flags });
  }
  return features;
}

/** 欠損の Run はどの水準の列も 0 になるので、欠損は別の水準を足さなくても区別できる。 */
function categoryFeatures(cells: ParameterCell[], levels: string[]): FeatureColumn[] {
  const features = levels.map(
    (level): FeatureColumn => ({ kind: 'category_level', level, values: new Float64Array(cells.length) }),
  );
  const featureByLevel = new Map(features.map((feature) => [feature.level, feature]));
  cells.forEach((cell, runIndex) => {
    if (cell.kind === 'missing') return;
    featureByLevel.get(String(cell.value))!.values[runIndex] = 1;
  });
  return features;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
