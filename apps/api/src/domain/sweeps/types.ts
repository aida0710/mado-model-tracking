// Sweep の探索空間・提案・早期打ち切りの domain 型。
// 語は W&B の sweep config（method、metric.goal、parameters.values/min/max/distribution、early_terminate）に合わせる。
// API 契約の公開型（contracts/sweeps.ts）との変換は sweeps-api が行う。

export type SweepMethod = 'grid' | 'random' | 'bayes';
export type SweepGoal = 'minimize' | 'maximize';

export type ParameterValue = string | number | boolean;
export type TrialParameters = Record<string, ParameterValue>;

/** 列挙した値から選ぶ */
export interface CategoricalParameter {
  values: ParameterValue[];
}

/** 常に同じ値を渡す */
export interface ConstantParameter {
  value: ParameterValue;
}

/**
 * uniform: [min, max] の一様分布
 * log_uniform: 対数が一様な分布。min/max は値そのもの（W&B の log_uniform_values に当たる。W&B の log_uniform は指数を渡す）
 * int_uniform: min 以上 max 以下の整数
 * q_uniform: min から q 刻みの値（既定 q=1）
 */
export type ParameterDistribution = 'uniform' | 'log_uniform' | 'int_uniform' | 'q_uniform';

export interface DistributionParameter {
  distribution: ParameterDistribution;
  min: number;
  max: number;
  /** q_uniform の刻み幅。ほかの分布では指定できない */
  q?: number;
}

export type ParameterDefinition = CategoricalParameter | ConstantParameter | DistributionParameter;

/** parameter 名 → 定義 */
export type SearchSpace = Record<string, ParameterDefinition>;

export type CompletedTrialState = 'finished' | 'failed' | 'early_stopped';

export interface CompletedTrial {
  parameters: TrialParameters;
  /** 目的メトリクスの集約値。記録が無い・NaN のときは null */
  objective: number | null;
  state: CompletedTrialState;
}

export interface SuggestInput {
  space: SearchSpace;
  method: SweepMethod;
  /** bayes が上位の試行を決めるのに使う。grid・random は使わない */
  goal: SweepGoal;
  seed: number;
  /** 0 から始まる試行番号。同じ seed・trialIndex なら同じ提案になる */
  trialIndex: number;
  completedTrials: CompletedTrial[];
  /** 実行中でまだ objective が無い試行の parameter */
  pendingParameters: TrialParameters[];
}

export type SuggestResult = { parameters: TrialParameters } | { exhausted: true };

export interface EarlyStoppingConfig {
  type: 'hyperband';
  /** 最初の rung の step */
  minIter: number;
  /** rung ごとに残す割合の逆数（上位 1/eta を残す） */
  eta: number;
  /** 試行の最大 step。指定するとこれ未満の rung だけを使う */
  maxIter?: number;
}

/** メトリクス履歴の1点 */
export interface MetricPoint {
  step: number;
  value: number;
}
