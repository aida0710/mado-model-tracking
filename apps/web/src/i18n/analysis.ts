import type { ImportanceUnavailableReason, ParameterExclusionReason, ParameterImportanceResult } from '@mmt/contracts';

// Exploring a set of Runs: parallel coordinates, parameter importance and the param scatter plot,
// shared by the Run list, Compare and Sweep pages.
export const analysisText = {
  analysisTitle: '探索結果の分析',
  analysisParallel: '平行座標',
  analysisImportance: 'パラメータ重要度',
  analysisScatter: '散布図',
  analysisTarget: '目的metric',
  analysisSweepObjective: 'Sweepのobjective',
  analysisNoMetrics: 'このRunの集合にはmetricが記録されていません',
  analysisTooFewRuns: '分析には2件以上のRunが必要です',
  analysisNoRuns: '対象のRunがありません',
  analysisAxes: '表示する軸',
  analysisMissing: '欠損',
  analysisMoveAxisLeft: '左へ移動',
  analysisMoveAxisRight: '右へ移動',
  analysisLogScale: '対数',
  analysisClearBrushes: '絞り込みを解除',
  analysisBrushHint: '軸の上をドラッグすると範囲で絞り込めます。軸をクリックすると解除します。',
  analysisColorLow: '小',
  analysisColorHigh: '大',
  analysisColorMissing: '値なし',
  analysisSelectedRuns: '絞り込んだRun',
  analysisParam: 'Param',
  analysisImportanceColumn: '重要度',
  analysisCorrelation: '相関',
  analysisCoverage: 'Coverage',
  analysisKind: '種類',
  analysisImportanceImpurity: '不純度の減少',
  analysisImportancePermutation: 'Permutation',
  analysisImportanceMethod: '重要度の計算',
  analysisExcluded: '計算から除いたparam',
  analysisNoParams: '値のあるparamがありません',
  analysisSortAscending: '昇順',
  analysisSortDescending: '降順',
  analysisScatterX: 'X軸',
  analysisScatterY: 'Y軸',
  analysisScatterColor: '色',
  analysisScatterNoColor: 'なし',
  analysisScatterNoPoints: '両方の軸に値のあるRunがありません',
  analysisScatterHint: '点をクリックするとRunの詳細を開きます。',
  analysisRunName: 'Run',
} as const;

// Text that embeds values; merged into catalog's textTemplates.
export const analysisTextTemplates = {
  analysisSelectionCount: (selected: number, total: number) => `${total} 件中 ${selected} 件`,
  analysisRunCount: (runCount: number, skipped: number) =>
    skipped > 0 ? `${runCount} 件のRunで計算（目的の値が無い ${skipped} 件を除外）` : `${runCount} 件のRunで計算`,
  analysisOutOfBagR2: (r2: string) => `モデルの当てはまり（out-of-bag R²）: ${r2}`,
  analysisAxisCount: (shown: number, total: number) => `${shown} / ${total}`,
  analysisMoreSelectedRuns: (count: number) => `ほか ${count} 件`,
};

export const importanceUnavailableReasonLabels: Record<ImportanceUnavailableReason, string> = {
  too_few_runs: '目的の値があるRunが5件未満のため、重要度は計算していません。相関だけを表示しています。',
};

export const parameterExclusionReasonLabels: Record<ParameterExclusionReason, string> = {
  high_cardinality: '値の種類が多すぎる（50種類を超える）カテゴリ',
  no_values: '値のあるRunが無い',
};

export const importanceTargetSourceLabels: Record<ParameterImportanceResult['targetSource'], string> = {
  latest_metric: 'metricの最新値',
  sweep_objective: 'Sweep試行の集約済みobjective',
};

export const analysisParamKindLabels = {
  numeric: '数値',
  categorical: 'カテゴリ',
} as const;
