import { createSeededRandom, type SeededRandom } from '../seededRandom.js';

/** 木の数。5000 Run × 100 parameter で 3秒以内に収まらなくなったら、ここを減らす。 */
export const RANDOM_FOREST_TREES = 100;
/** 深すぎる木は少数の Run に合わせ込み、重要度がノイズに引きずられるので浅く止める。 */
export const RANDOM_FOREST_MAX_DEPTH = 8;
export const RANDOM_FOREST_MIN_LEAF_SIZE = 2;
/**
 * 分割の候補を、列ごとに最大この数の区間（区間0は欠損）に分けた境界だけにする。
 * Run ごとの全ての値を候補にする厳密な CART は 5000 Run で節ごとの並べ替えが重く、
 * 区間に分けても重要度の順位はほとんど変わらないため。
 */
export const RANDOM_FOREST_MAX_BINS = 64;

const MISSING_BIN = 0;
const MAX_VALUE_BINS = RANDOM_FOREST_MAX_BINS - 1;
const LEAF = -1;

export interface RandomForestInput {
  /** 列ごとの値（Run 順）。欠損は NaN。 */
  features: Float64Array[];
  /** 列ごとの所属グループ。one-hot や欠損フラグを元の parameter にまとめるために使う。 */
  featureGroups: number[];
  groupCount: number;
  target: Float64Array;
  seed: number;
}

export interface RandomForestImportance {
  /** 分散減少の合計をグループ単位で平均し、合計1に正規化した値。分割が1つも無ければ全て0。 */
  impurityImportance: number[];
  /**
   * グループの列をまとめて out-of-bag の Run 間で並べ替えたときの、平均二乗誤差の増加量。
   * 目的メトリクスの分散で割り、R² の低下と同じ尺度にしている（負の値は「効いていない」の意味）。
   */
  permutationImportance: number[];
  /** out-of-bag 予測の R²。予測できた Run が2未満か目的メトリクスの分散が0なら null。 */
  outOfBagR2: number | null;
}

interface BinnedFeatures {
  bins: Uint8Array[];
  binCounts: number[];
}

interface RegressionTree {
  /** 節ごとの分割列。葉は LEAF。 */
  splitFeature: number[];
  /** 分割列のグループ。permutation importance で列ごとにグループを引き直さないため節に持つ。 */
  splitGroup: number[];
  /** この区間以下なら左へ進む。 */
  splitBin: number[];
  left: number[];
  right: number[];
  value: number[];
}

export function computeRandomForestImportance(input: RandomForestInput): RandomForestImportance {
  const runCount = input.target.length;
  const random = createSeededRandom(input.seed);
  const binned = binFeatures(input.features);
  const impurityTotals = new Float64Array(input.groupCount);
  const permutationTotals = new Float64Array(input.groupCount);
  const outOfBagSums = new Float64Array(runCount);
  const outOfBagCounts = new Uint32Array(runCount);
  let permutationTreeCount = 0;

  for (let treeIndex = 0; treeIndex < RANDOM_FOREST_TREES; treeIndex += 1) {
    const { rows, inBagCounts } = drawBootstrapSample(runCount, random);
    const treeImpurity = new Float64Array(input.groupCount);
    const tree = growTree({
      rows,
      binned,
      target: input.target,
      featureGroups: input.featureGroups,
      treeImpurity,
      random,
    });
    addNormalized(impurityTotals, treeImpurity);

    const outOfBagRows = rowsNotInBag(inBagCounts);
    for (const row of outOfBagRows) {
      outOfBagSums[row]! += predictRow(tree, binned, row);
      outOfBagCounts[row]! += 1;
    }
    if (outOfBagRows.length < 2) continue;
    permutationTreeCount += 1;
    addPermutationIncreases({ tree, binned, target: input.target, outOfBagRows, random, totals: permutationTotals });
  }

  const targetVariance = populationVariance(input.target);
  return {
    impurityImportance: normalizeToUnitSum(impurityTotals),
    permutationImportance: Array.from(permutationTotals, (total) =>
      permutationTreeCount === 0 || targetVariance === 0 ? 0 : total / permutationTreeCount / targetVariance,
    ),
    outOfBagR2: outOfBagCoefficientOfDetermination(input.target, outOfBagSums, outOfBagCounts),
  };
}

function binFeatures(features: Float64Array[]): BinnedFeatures {
  const bins: Uint8Array[] = [];
  const binCounts: number[] = [];
  for (const values of features) {
    const edges = binEdges(values);
    bins.push(Uint8Array.from(values, (value) => (Number.isNaN(value) ? MISSING_BIN : 1 + countBelow(edges, value))));
    binCounts.push(edges.length + 2);
  }
  return { bins, binCounts };
}

/** 区間の上端。値の種類が少なければ値ごとに1区間、多ければ分位点で区切る。 */
function binEdges(values: Float64Array): number[] {
  const sorted = Float64Array.from(values.filter((value) => !Number.isNaN(value))).sort();
  const distinct = [...new Set(sorted)];
  if (distinct.length <= MAX_VALUE_BINS) return distinct.slice(0, -1);
  const edges: number[] = [];
  for (let quantile = 1; quantile < MAX_VALUE_BINS; quantile += 1) {
    const edge = sorted[Math.floor((quantile * sorted.length) / MAX_VALUE_BINS)]!;
    if (edges.length === 0 || edge > edges[edges.length - 1]!) edges.push(edge);
  }
  return edges;
}

/** edges のうち value より小さいものの数（二分探索）。 */
function countBelow(edges: number[], value: number): number {
  let low = 0;
  let high = edges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (edges[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function drawBootstrapSample(runCount: number, random: SeededRandom): { rows: Int32Array; inBagCounts: Uint16Array } {
  const rows = new Int32Array(runCount);
  const inBagCounts = new Uint16Array(runCount);
  for (let index = 0; index < runCount; index += 1) {
    const row = Math.floor(random.next() * runCount);
    rows[index] = row;
    inBagCounts[row]! += 1;
  }
  return { rows, inBagCounts };
}

function rowsNotInBag(inBagCounts: Uint16Array): number[] {
  const rows: number[] = [];
  inBagCounts.forEach((count, row) => {
    if (count === 0) rows.push(row);
  });
  return rows;
}

interface TreeGrowth {
  rows: Int32Array;
  binned: BinnedFeatures;
  target: Float64Array;
  featureGroups: number[];
  /** 分割で減った二乗誤差を、分割列のグループごとに足し込む先。 */
  treeImpurity: Float64Array;
  random: SeededRandom;
}

interface BestSplit {
  feature: number;
  bin: number;
  gain: number;
}

function growTree(growth: TreeGrowth): RegressionTree {
  const tree: RegressionTree = { splitFeature: [], splitGroup: [], splitBin: [], left: [], right: [], value: [] };
  const featureCount = growth.binned.bins.length;
  // 特徴の部分抽出は回帰でも sqrt にする。強い1列が全ての木の根を占め、他の列の重要度が0に潰れるのを防ぐ。
  const sampledFeatureCount = Math.max(1, Math.floor(Math.sqrt(featureCount)));
  const featureOrder = Int32Array.from({ length: featureCount }, (_, index) => index);
  const histogram = { counts: new Int32Array(RANDOM_FOREST_MAX_BINS), sums: new Float64Array(RANDOM_FOREST_MAX_BINS) };

  const growNode = (rows: Int32Array, depth: number): number => {
    const node = tree.value.length;
    const mean = meanOf(growth.target, rows);
    tree.splitFeature.push(LEAF);
    tree.splitGroup.push(LEAF);
    tree.splitBin.push(0);
    tree.left.push(LEAF);
    tree.right.push(LEAF);
    tree.value.push(mean);
    if (depth >= RANDOM_FOREST_MAX_DEPTH || rows.length < 2 * RANDOM_FOREST_MIN_LEAF_SIZE) return node;
    const squaredError = squaredErrorAround(growth.target, rows, mean);
    // 定数の目的値でも平均の丸め誤差で squaredError がわずかに正になるので、その程度は分割しない。
    if (squaredError <= Number.EPSILON * rows.length * mean * mean) return node;

    let best: BestSplit | null = null;
    for (let sample = 0; sample < Math.min(sampledFeatureCount, featureCount); sample += 1) {
      const swapWith = sample + Math.floor(growth.random.next() * (featureCount - sample));
      const feature = featureOrder[swapWith]!;
      featureOrder[swapWith] = featureOrder[sample]!;
      featureOrder[sample] = feature;
      const candidate = bestSplitOfFeature({ growth, histogram, rows, mean, feature });
      if (candidate && (best === null || candidate.gain > best.gain)) best = candidate;
    }
    // 丸め誤差だけの改善で分割すると、効いていない列に重要度が付く。
    if (best === null || best.gain <= 1e-12 * squaredError) return node;

    const group = growth.featureGroups[best.feature]!;
    growth.treeImpurity[group]! += best.gain;
    const { leftRows, rightRows } = partitionRows(rows, growth.binned.bins[best.feature]!, best.bin);
    tree.splitFeature[node] = best.feature;
    tree.splitGroup[node] = group;
    tree.splitBin[node] = best.bin;
    tree.left[node] = growNode(leftRows, depth + 1);
    tree.right[node] = growNode(rightRows, depth + 1);
    return node;
  };

  growNode(growth.rows, 0);
  return tree;
}

function partitionRows(rows: Int32Array, featureBins: Uint8Array, splitBin: number) {
  let leftCount = 0;
  for (const row of rows) if (featureBins[row]! <= splitBin) leftCount += 1;
  const leftRows = new Int32Array(leftCount);
  const rightRows = new Int32Array(rows.length - leftCount);
  let leftIndex = 0;
  let rightIndex = 0;
  for (const row of rows) {
    if (featureBins[row]! <= splitBin) leftRows[leftIndex++] = row;
    else rightRows[rightIndex++] = row;
  }
  return { leftRows, rightRows };
}

/**
 * 1列について、分散減少が最大になる区間の境界を探す。
 * 目的値を節の平均で中心化して集計するのは、平均が大きく分散が小さい目的値で差し引きの桁落ちを避けるため。
 */
function bestSplitOfFeature(search: {
  growth: TreeGrowth;
  histogram: { counts: Int32Array; sums: Float64Array };
  rows: Int32Array;
  mean: number;
  feature: number;
}): BestSplit | null {
  const { counts, sums } = search.histogram;
  const binCount = search.growth.binned.binCounts[search.feature]!;
  const featureBins = search.growth.binned.bins[search.feature]!;
  counts.fill(0, 0, binCount);
  sums.fill(0, 0, binCount);
  for (const row of search.rows) {
    const bin = featureBins[row]!;
    counts[bin]! += 1;
    sums[bin]! += search.growth.target[row]! - search.mean;
  }
  const total = search.rows.length;
  let leftCount = 0;
  let leftSum = 0;
  let best: BestSplit | null = null;
  for (let bin = 0; bin < binCount - 1; bin += 1) {
    leftCount += counts[bin]!;
    leftSum += sums[bin]!;
    const rightCount = total - leftCount;
    if (leftCount < RANDOM_FOREST_MIN_LEAF_SIZE) continue;
    if (rightCount < RANDOM_FOREST_MIN_LEAF_SIZE) break;
    // 中心化しているので右の合計は -leftSum。減る二乗誤差は sl²/nl + sr²/nr。
    const gain = (leftSum * leftSum) / leftCount + (leftSum * leftSum) / rightCount;
    if (best === null || gain > best.gain) best = { feature: search.feature, bin, gain };
  }
  return best;
}

function predictRow(tree: RegressionTree, binned: BinnedFeatures, row: number): number {
  let node = 0;
  while (tree.splitFeature[node] !== LEAF) {
    const feature = tree.splitFeature[node]!;
    node = binned.bins[feature]![row]! <= tree.splitBin[node]! ? tree.left[node]! : tree.right[node]!;
  }
  return tree.value[node]!;
}

/**
 * group に属する列だけ substituteRow の値を使って予測する（permutation importance 用）。
 * 呼び出し回数が木の数 × グループ数 × out-of-bag の Run 数になるので、呼び出し側は substitution を使い回して書き換える。
 */
function predictRowWithSubstitute(
  tree: RegressionTree,
  binned: BinnedFeatures,
  substitution: { row: number; group: number; substituteRow: number },
): number {
  let node = 0;
  while (tree.splitFeature[node] !== LEAF) {
    const feature = tree.splitFeature[node]!;
    const sourceRow = tree.splitGroup[node] === substitution.group ? substitution.substituteRow : substitution.row;
    node = binned.bins[feature]![sourceRow]! <= tree.splitBin[node]! ? tree.left[node]! : tree.right[node]!;
  }
  return tree.value[node]!;
}

/**
 * 予測が変わりうるのは、元の経路にそのグループの分割を含む Run だけなので、その Run だけを予測し直す。
 * 全 Run を予測し直すと 5000 Run × 100 parameter で計算時間の大半を占めたため。
 */
function addPermutationIncreases(context: {
  tree: RegressionTree;
  binned: BinnedFeatures;
  target: Float64Array;
  outOfBagRows: number[];
  random: SeededRandom;
  totals: Float64Array;
}): void {
  const { tree, binned, target, outOfBagRows } = context;
  const baselineErrors = outOfBagRows.map((row) => (target[row]! - predictRow(tree, binned, row)) ** 2);
  const positionsByGroup = outOfBagPositionsByPathGroup(tree, binned, outOfBagRows);
  // 乱数を引く順をグループ番号順に固定し、並べ替えの結果が集計の実装順に左右されないようにする。
  for (const group of [...positionsByGroup.keys()].sort((left, right) => left - right)) {
    const shuffled = shuffledCopy(outOfBagRows, context.random);
    const substitution = { row: 0, group, substituteRow: 0 };
    let errorIncrease = 0;
    for (const position of positionsByGroup.get(group)!) {
      substitution.row = outOfBagRows[position]!;
      substitution.substituteRow = shuffled[position]!;
      const permutedError = (target[substitution.row]! - predictRowWithSubstitute(tree, binned, substitution)) ** 2;
      errorIncrease += permutedError - baselineErrors[position]!;
    }
    context.totals[group]! += errorIncrease / outOfBagRows.length;
  }
}

/** グループごとに、元の経路でそのグループの分割を通る out-of-bag の Run の位置を集める。 */
function outOfBagPositionsByPathGroup(
  tree: RegressionTree,
  binned: BinnedFeatures,
  outOfBagRows: number[],
): Map<number, number[]> {
  const positionsByGroup = new Map<number, number[]>();
  outOfBagRows.forEach((row, position) => {
    let node = 0;
    while (tree.splitFeature[node] !== LEAF) {
      const group = tree.splitGroup[node]!;
      const positions = positionsByGroup.get(group) ?? [];
      // 同じ経路で同じグループを2回通っても1回だけ数える。
      if (positions[positions.length - 1] !== position) positions.push(position);
      positionsByGroup.set(group, positions);
      const feature = tree.splitFeature[node]!;
      node = binned.bins[feature]![row]! <= tree.splitBin[node]! ? tree.left[node]! : tree.right[node]!;
    }
  });
  return positionsByGroup;
}

function shuffledCopy(rows: number[], random: SeededRandom): number[] {
  const copy = [...rows];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random.next() * (index + 1));
    [copy[index], copy[swapWith]] = [copy[swapWith]!, copy[index]!];
  }
  return copy;
}

/** 木ごとに合計1へ正規化してから足す。強い木1本の分散減少の大きさに全体が引きずられないようにするため。 */
function addNormalized(totals: Float64Array, treeImpurity: Float64Array): void {
  const sum = treeImpurity.reduce((accumulated, value) => accumulated + value, 0);
  if (sum <= 0) return;
  treeImpurity.forEach((value, group) => {
    totals[group]! += value / sum;
  });
}

function normalizeToUnitSum(values: Float64Array): number[] {
  const sum = values.reduce((accumulated, value) => accumulated + value, 0);
  return Array.from(values, (value) => (sum > 0 ? value / sum : 0));
}

function meanOf(target: Float64Array, rows: Int32Array): number {
  let sum = 0;
  for (const row of rows) sum += target[row]!;
  return sum / rows.length;
}

function squaredErrorAround(target: Float64Array, rows: Int32Array, mean: number): number {
  let sum = 0;
  for (const row of rows) sum += (target[row]! - mean) ** 2;
  return sum;
}

function populationVariance(values: Float64Array): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((accumulated, value) => accumulated + value, 0) / values.length;
  return values.reduce((accumulated, value) => accumulated + (value - mean) ** 2, 0) / values.length;
}

function outOfBagCoefficientOfDetermination(
  target: Float64Array,
  outOfBagSums: Float64Array,
  outOfBagCounts: Uint32Array,
): number | null {
  const predictedRows: number[] = [];
  outOfBagCounts.forEach((count, row) => {
    if (count > 0) predictedRows.push(row);
  });
  if (predictedRows.length < 2) return null;
  const mean = predictedRows.reduce((accumulated, row) => accumulated + target[row]!, 0) / predictedRows.length;
  let residual = 0;
  let totalVariation = 0;
  for (const row of predictedRows) {
    residual += (target[row]! - outOfBagSums[row]! / outOfBagCounts[row]!) ** 2;
    totalVariation += (target[row]! - mean) ** 2;
  }
  return totalVariation === 0 ? null : 1 - residual / totalVariation;
}
