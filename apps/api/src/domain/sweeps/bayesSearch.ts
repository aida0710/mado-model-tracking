// method 'bayes'（W&B と同じ名前）の実装。中身は TPE（Tree-structured Parzen Estimator）。
// GP（ガウス過程）を採らない理由:
// - GP は行列分解などの数値計算ライブラリが要る。TPE は1次元の密度推定だけなので外部依存なしで書ける。
// - categorical と連続値が混ざった空間を、parameter ごとの密度で自然に扱える（GP は距離の定義が要る）。
import { createSeededRandom, deriveSeed, type SeededRandom } from '../seededRandom.js';
import { snapToDistribution } from './parameterSampling.js';
import { suggestRandom } from './randomSearch.js';
import { isCategoricalParameter, isConstantParameter, sortedParameterNames } from './searchSpace.js';
import { compareTrialsByObjective } from './trialObjective.js';
import type {
  CategoricalParameter,
  DistributionParameter,
  ParameterDefinition,
  ParameterValue,
  SuggestInput,
  SuggestResult,
  TrialParameters,
} from './types.js';

/** これ未満の完了試行では密度推定が当てにならないので random と同じ値を返す */
export const BAYES_STARTUP_TRIALS = 10;
/** objective が上位のこの割合を「良い試行」l(x)、残りを g(x) にする */
export const BAYES_GAMMA = 0.25;
/** parameter ごとに l(x) から引く候補の数 */
export const BAYES_CANDIDATES = 24;

/** random の乱数系列と分けるための系列番号 */
const TPE_RANDOM_STREAM = 1;
/** 候補を範囲内に引き直す回数。超えたら範囲の端に寄せる */
const MAX_TRUNCATED_DRAWS = 32;
/** categorical の頻度に足す擬似回数（一度も出ていない値も選ばれうるようにする） */
const CATEGORICAL_SMOOTHING = 1;
/** kernel の幅の下限を決める観測数の上限（hyperopt と同じく幅を範囲の1/100より狭くしない） */
const MAX_BANDWIDTH_DIVISOR = 100;
/** 0 での割り算と log(0) を避ける下限 */
const MIN_PROBABILITY = 1e-12;

interface Observation {
  parameters: TrialParameters;
  objective: number;
}

/**
 * failed は除外する。early_stopped は打ち切った時点の objective を使う（W&B と同じく、打ち切った試行も
 * 「その領域は悪い」という情報になる）。objective が無い試行は使えない。
 */
function usableObservations(input: SuggestInput): Observation[] {
  const observations: Observation[] = [];
  for (const trial of input.completedTrials) {
    if (trial.state === 'failed' || trial.objective === null || !Number.isFinite(trial.objective)) continue;
    observations.push({ parameters: trial.parameters, objective: trial.objective });
  }
  return observations;
}

export function suggestBayes(input: SuggestInput): SuggestResult {
  const observations = usableObservations(input);
  if (observations.length < BAYES_STARTUP_TRIALS) return suggestRandom(input.space, input.seed, input.trialIndex);

  const compare = compareTrialsByObjective(input.goal);
  const ranked = observations
    .map((observation, trialIndex) => ({ ...observation, trialIndex }))
    .sort(compare);
  const goodCount = Math.max(1, Math.ceil(BAYES_GAMMA * ranked.length));
  const good = ranked.slice(0, goodCount).map((observation) => observation.parameters);
  // 実行中の試行は結果が分からないので g(x) 側に入れ、並列に同じ場所ばかり提案しないようにする。
  const others = [...ranked.slice(goodCount).map((observation) => observation.parameters), ...input.pendingParameters];

  const random = createSeededRandom(deriveSeed(deriveSeed(input.seed, input.trialIndex), TPE_RANDOM_STREAM));
  const parameters: TrialParameters = {};
  // hyperopt と同じく parameter ごとに独立に l(x)/g(x) を最大にする。
  for (const name of sortedParameterNames(input.space)) {
    const definition = input.space[name]!;
    parameters[name] = suggestParameter({
      definition,
      goodValues: collectValues(good, name),
      otherValues: collectValues(others, name),
      random,
    });
  }
  return { parameters };
}

function collectValues(trials: readonly TrialParameters[], name: string): ParameterValue[] {
  return trials.flatMap((parameters) => (name in parameters ? [parameters[name]!] : []));
}

interface ParameterSuggestion {
  definition: ParameterDefinition;
  goodValues: ParameterValue[];
  otherValues: ParameterValue[];
  random: SeededRandom;
}

function suggestParameter({ definition, goodValues, otherValues, random }: ParameterSuggestion): ParameterValue {
  if (isConstantParameter(definition)) return definition.value;
  if (isCategoricalParameter(definition)) return suggestCategorical({ definition, goodValues, otherValues, random });
  return suggestNumeric({ definition, goodValues, otherValues, random });
}

function suggestCategorical({
  definition,
  goodValues,
  otherValues,
  random,
}: ParameterSuggestion & { definition: CategoricalParameter }): ParameterValue {
  const goodWeights = smoothedFrequencies(definition, goodValues);
  const otherWeights = smoothedFrequencies(definition, otherValues);
  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let candidate = 0; candidate < BAYES_CANDIDATES; candidate += 1) {
    const index = drawIndex(goodWeights, random);
    const score = Math.log(goodWeights[index]!) - Math.log(otherWeights[index]!);
    if (score > bestScore) [bestIndex, bestScore] = [index, score];
  }
  return definition.values[bestIndex]!;
}

/** 値ごとの平滑化した出現割合（合計1） */
function smoothedFrequencies(definition: CategoricalParameter, observed: ParameterValue[]): number[] {
  const counts = definition.values.map(() => CATEGORICAL_SMOOTHING);
  for (const value of observed) {
    const index = definition.values.indexOf(value);
    if (index >= 0) counts[index]! += 1;
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.map((count) => count / total);
}

function drawIndex(weights: number[], random: SeededRandom): number {
  let remaining = random.next();
  for (let index = 0; index < weights.length; index += 1) {
    remaining -= weights[index]!;
    if (remaining < 0) return index;
  }
  return weights.length - 1;
}

/** 密度推定に使う空間。log_uniform は対数空間で推定する */
interface ModelSpace {
  low: number;
  high: number;
  toModel(value: number): number;
  fromModel(position: number): number;
}

function modelSpaceOf(definition: DistributionParameter): ModelSpace {
  if (definition.distribution === 'log_uniform')
    return { low: Math.log(definition.min), high: Math.log(definition.max), toModel: Math.log, fromModel: Math.exp };
  const identity = (value: number) => value;
  return { low: definition.min, high: definition.max, toModel: identity, fromModel: identity };
}

interface Kernel {
  mean: number;
  bandwidth: number;
  /** [low, high] で切り詰めた正規分布の正規化定数 */
  mass: number;
}

/**
 * 観測点ごとのガウス kernel に、範囲全体を覆う事前分布の kernel を1つ混ぜた Parzen 推定（重みは等しい）。
 * 幅は hyperopt と同じく隣の点までの距離の大きい方で、範囲の幅/min(100, n+1) 以上・範囲の幅以下にする。
 */
function buildParzenEstimator(observed: number[], space: ModelSpace): Kernel[] {
  const width = space.high - space.low;
  const prior = { mean: (space.low + space.high) / 2, isPrior: true };
  const points = [...observed.map((mean) => ({ mean, isPrior: false })), prior].sort((left, right) => left.mean - right.mean);
  const minBandwidth = width / Math.min(MAX_BANDWIDTH_DIVISOR, points.length);
  return points.map((point, index) => {
    const leftGap = point.mean - (points[index - 1]?.mean ?? space.low);
    const rightGap = (points[index + 1]?.mean ?? space.high) - point.mean;
    const bandwidth = point.isPrior ? width : Math.min(width, Math.max(minBandwidth, leftGap, rightGap));
    const mass =
      standardNormalCdf((space.high - point.mean) / bandwidth) - standardNormalCdf((space.low - point.mean) / bandwidth);
    return { mean: point.mean, bandwidth, mass: Math.max(mass, MIN_PROBABILITY) };
  });
}

function logDensity(kernels: readonly Kernel[], position: number): number {
  let density = 0;
  for (const kernel of kernels) {
    const standardized = (position - kernel.mean) / kernel.bandwidth;
    density += Math.exp(-0.5 * standardized * standardized) / (kernel.bandwidth * Math.sqrt(2 * Math.PI) * kernel.mass);
  }
  return Math.log(Math.max(density / kernels.length, MIN_PROBABILITY));
}

function drawFromKernels(kernels: readonly Kernel[], space: ModelSpace, random: SeededRandom): number {
  const kernel = kernels[random.nextInt(0, kernels.length - 1)]!;
  for (let attempt = 0; attempt < MAX_TRUNCATED_DRAWS; attempt += 1) {
    const position = kernel.mean + kernel.bandwidth * random.nextGaussian();
    if (position >= space.low && position <= space.high) return position;
  }
  return Math.min(space.high, Math.max(space.low, kernel.mean));
}

function suggestNumeric({
  definition,
  goodValues,
  otherValues,
  random,
}: ParameterSuggestion & { definition: DistributionParameter }): ParameterValue {
  const space = modelSpaceOf(definition);
  const toPositions = (values: ParameterValue[]) =>
    values
      .filter((value): value is number => typeof value === 'number' && value >= definition.min && value <= definition.max)
      .map(space.toModel);
  const goodKernels = buildParzenEstimator(toPositions(goodValues), space);
  const otherKernels = buildParzenEstimator(toPositions(otherValues), space);
  let best = definition.min;
  let bestScore = -Infinity;
  for (let candidate = 0; candidate < BAYES_CANDIDATES; candidate += 1) {
    const value = snapToDistribution(definition, space.fromModel(drawFromKernels(goodKernels, space, random)));
    const position = space.toModel(value);
    const score = logDensity(goodKernels, position) - logDensity(otherKernels, position);
    if (score > bestScore) [best, bestScore] = [value, score];
  }
  return best;
}

/** 標準正規分布の累積分布関数（Abramowitz & Stegun 7.1.26 による erf の近似。誤差 1.5e-7 以下） */
function standardNormalCdf(standardized: number): number {
  const x = Math.abs(standardized) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - polynomial * Math.exp(-x * x);
  return standardized >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
