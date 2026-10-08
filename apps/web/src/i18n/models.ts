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
} as const;

export const modelAliasSourceLabels: Record<ModelAliasEventSource, string> = {
  web: 'Web',
  api: 'API',
  mlflow: 'MLflow',
  promotion_policy: '昇格ポリシー',
  version_deleted: '版の削除',
  model_deleted: 'モデルの削除',
};

// Text that embeds values.
export const modelsTextTemplates = {
  removeAliasConfirm: (alias: string, version: string) =>
    `Alias「${alias}」（版 ${version}）を解除します。解除したことは履歴に残ります。`,
};
