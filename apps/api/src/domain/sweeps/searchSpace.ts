import { DomainError } from '../errors.js';
import type {
  CategoricalParameter,
  ConstantParameter,
  DistributionParameter,
  ParameterDefinition,
  ParameterValue,
  SearchSpace,
  SweepMethod,
} from './types.js';

/** 1つの Sweep の parameter 数の上限。Run の params 一覧と画面の表で扱える数に抑える */
export const MAX_SWEEP_PARAMETERS = 50;
/** categorical の値の数の上限。grid の組み合わせ上限と合わせて提案の計算量を抑える */
export const MAX_CATEGORICAL_VALUES = 1000;
/** grid の組み合わせ数の上限。これを超える探索は random か bayes で行う */
export const MAX_GRID_COMBINATIONS = 10000;

const DISTRIBUTIONS = new Set(['uniform', 'log_uniform', 'int_uniform', 'q_uniform']);

export function isCategoricalParameter(definition: ParameterDefinition): definition is CategoricalParameter {
  return 'values' in definition;
}

export function isConstantParameter(definition: ParameterDefinition): definition is ConstantParameter {
  return 'value' in definition;
}

export function isDistributionParameter(definition: ParameterDefinition): definition is DistributionParameter {
  return 'distribution' in definition;
}

/** 提案と grid の列挙で使う決まった順（名前の符号単位での昇順。locale に依存させない） */
export function sortedParameterNames(space: SearchSpace): string[] {
  return Object.keys(space).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** grid で列挙する値（categorical は宣言順、constant は1つ） */
export function gridValues(definition: ParameterDefinition): ParameterValue[] {
  if (isCategoricalParameter(definition)) return definition.values;
  if (isConstantParameter(definition)) return [definition.value];
  throw new RangeError('連続分布の parameter は grid で列挙できません');
}

export function countGridCombinations(space: SearchSpace): number {
  return sortedParameterNames(space).reduce((count, name) => count * gridValues(space[name]!).length, 1);
}

function invalid(message: string): never {
  throw new DomainError(422, message, 'sweep_space_invalid');
}

function isValidParameterValue(value: unknown): value is ParameterValue {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' || typeof value === 'boolean';
}

function validateCategorical(name: string, definition: CategoricalParameter): void {
  if (!Array.isArray(definition.values) || definition.values.length === 0)
    invalid(`parameter「${name}」の values が空です`);
  if (definition.values.length > MAX_CATEGORICAL_VALUES)
    invalid(`parameter「${name}」の values は${MAX_CATEGORICAL_VALUES}個までです（${definition.values.length}個）`);
  const seen = new Set<ParameterValue>();
  for (const value of definition.values) {
    if (!isValidParameterValue(value))
      invalid(`parameter「${name}」の values には文字列・有限の数値・真偽値だけを使えます`);
    // 重複があると grid が同じ組を2回試し、bayes の頻度推定も偏る。
    if (seen.has(value)) invalid(`parameter「${name}」の values に重複した値 ${JSON.stringify(value)} があります`);
    seen.add(value);
  }
}

function validateDistribution(name: string, definition: DistributionParameter): void {
  const { distribution, min, max, q } = definition;
  if (!DISTRIBUTIONS.has(distribution))
    invalid(`parameter「${name}」の distribution「${String(distribution)}」は使えません`);
  if (!Number.isFinite(min) || !Number.isFinite(max))
    invalid(`parameter「${name}」の min と max には有限の数値が必要です`);
  if (!(min < max)) invalid(`parameter「${name}」は min < max である必要があります（min=${min}, max=${max}）`);
  if (distribution === 'log_uniform' && min <= 0)
    invalid(`parameter「${name}」は log_uniform なので min > 0 である必要があります（min=${min}）`);
  if (distribution === 'int_uniform' && (!Number.isInteger(min) || !Number.isInteger(max)))
    invalid(`parameter「${name}」は int_uniform なので min と max は整数である必要があります`);
  if (q === undefined) return;
  if (distribution !== 'q_uniform') invalid(`parameter「${name}」の q は q_uniform のときだけ指定できます`);
  if (!Number.isFinite(q) || q <= 0) invalid(`parameter「${name}」の q は正の数である必要があります（q=${q}）`);
  if (q > max - min) invalid(`parameter「${name}」の q が min から max までの幅より大きいです（q=${q}）`);
}

function validateParameter(name: string, definition: ParameterDefinition): void {
  if (name.length === 0) invalid('parameter 名が空です');
  if (typeof definition !== 'object' || definition === null) invalid(`parameter「${name}」の定義がありません`);
  const kinds = [isCategoricalParameter, isConstantParameter, isDistributionParameter].filter((is) => is(definition));
  if (kinds.length !== 1)
    invalid(`parameter「${name}」には values・value・distribution のどれか1つだけを指定してください`);
  if (isCategoricalParameter(definition)) return validateCategorical(name, definition);
  if (isConstantParameter(definition)) {
    if (!isValidParameterValue(definition.value))
      invalid(`parameter「${name}」の value には文字列・有限の数値・真偽値だけを使えます`);
    return;
  }
  validateDistribution(name, definition);
}

/** 探索空間を検証する。違反は DomainError 422 sweep_space_invalid で、message に該当する parameter を書く */
export function validateSearchSpace(space: SearchSpace, method: SweepMethod): void {
  const names = sortedParameterNames(space);
  if (names.length === 0) invalid('parameter が1つもありません');
  if (names.length > MAX_SWEEP_PARAMETERS)
    invalid(`parameter は${MAX_SWEEP_PARAMETERS}個までです（${names.length}個）`);
  for (const name of names) validateParameter(name, space[name]!);
  if (method !== 'grid') return;
  // W&B と同じく、連続分布は grid で列挙しない。
  const continuous = names.filter((name) => isDistributionParameter(space[name]!));
  if (continuous.length > 0)
    invalid(`grid では values か value の parameter だけを使えます（連続分布: ${continuous.join(', ')}）`);
  const combinations = countGridCombinations(space);
  if (combinations > MAX_GRID_COMBINATIONS)
    invalid(`grid の組み合わせ数は${MAX_GRID_COMBINATIONS}までです（${combinations}通り）`);
}
