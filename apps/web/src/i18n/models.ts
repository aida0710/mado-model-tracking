import type { ModelAliasEventSource } from '@mmt/contracts';

// Model registry labels: alias assignment, removal and alias history.
export const modelsText = {
  aliasReason: '理由',
  aliasReasonPlaceholder: '例: 評価でWERが改善したため',
  removeAlias: 'Aliasを解除',
  aliasesEmpty: 'Aliasはまだ設定されていません',
  aliasHistory: 'Aliasの履歴',
  aliasHistoryEmpty: 'Aliasの変更履歴はまだありません',
  aliasHistoryLoadMore: 'さらに読み込む',
  aliasChangedAt: '日時',
  aliasVersionChange: '旧版 → 新版',
  aliasActor: '操作者',
  aliasSource: '経路',
  aliasActorSystem: 'システム',
  aliasActorToken: 'APIトークン',
  aliasUnassigned: '（なし）',
  // Model version page: training Run → version → inference/evaluation Runs.
  modelVersionNotFound: 'モデル版が見つかりません',
  modelVersionOpenPage: '版の詳細画面を開く',
  modelVersionArtifactOpen: 'Artifactsで開く',
  modelVersionWeightsArtifact: '重みのArtifact',
  modelVersionSummary: '概要',
  modelVersionLineage: '学習Run → 版 → 推論・評価Run',
  modelVersionLineageTruncated: '新しい順に最大20件の推論・評価Runを表示しています。',
  modelVersionAliases: 'この版のAlias',
  modelVersionModel: 'モデル',
  modelVersionAutomation: '自動実行',
  modelVersionAutomationTruncated: '新しい順に200件を表示しています。古い実行は自動実行履歴で確認できます。',
  modelVersionNoExecutions: 'この版の自動実行はまだありません',
  evaluationResults: '評価結果',
  evaluationResultsEmpty: 'この版の評価Runはまだありません',
  evaluationResultsTruncated: '新しい順に200件のRunから集約しています。',
  evaluationSummary: '指標の集約',
  evaluationSummaryHint: '各指標の最新値（成功した評価Runのうち、終了が最も新しいもの）。基準版は同じ評価コード版・正解セットの評価と比べます。',
  evaluationSummaryEmpty: '成功した評価Runに指標がありません',
  evaluationLatestValue: '最新値',
  evaluationDeltaSign: '差の符号',
  evaluationRuns: '評価Run',
  evaluationAutomatic: '自動評価',
  evaluationReferenceSet: '正解セット',
  evaluationUpstreamOutputs: '上流の出力',
  versionPromotionEvaluations: 'この版の昇格判定',
  versionPromotionEvaluationsEmpty: 'この版を候補とした昇格判定はまだありません',
  runDownstream: 'このRunから起動したRun',
  runDownstreamEmpty: 'このRunから起動したRunはありません',
  loadMore: 'さらに読み込む',
} as const;

// The sign of candidate − baseline; better or worse depends on the metric and is not shown.
export const deltaSignLabels = {
  positive: '＋（基準より大きい）',
  negative: '－（基準より小さい）',
  zero: '±0（同じ）',
} as const;

export const modelAliasSourceLabels: Record<ModelAliasEventSource, string> = {
  web: 'Web',
  api: 'API',
  mlflow: 'MLflow',
  promotion_policy: '昇格policy',
  version_deleted: '版の削除',
  model_deleted: 'モデルの削除',
};

// Text that embeds values.
export const modelsTextTemplates = {
  baselineValue: (alias: string) => `基準版（${alias}）`,
  automaticByRule: (ruleName: string) => `自動評価（${ruleName}）`,
  removeAliasConfirm: (alias: string, version: string) =>
    `Alias「${alias}」（版 ${version}）を解除します。解除したことは履歴に残ります。`,
};
