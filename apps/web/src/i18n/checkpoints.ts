import type { RunCheckpointSource } from '@mmt/contracts';

// Run checkpoints and resuming training from one: the Run tab, the resume dialog and the Jobs page.
export const checkpointsText = {
  checkpoints: 'Checkpoint',
  checkpointEmpty: 'このRunのcheckpointはまだありません',
  checkpointShowHidden: '保持数を超えた古いcheckpointも表示する',
  checkpointHidden: '保持数外',
  checkpointHiddenHint: '新しいcheckpointが保持数を超えたため一覧から外れています。再開には使えます。',
  checkpointOptimizer: 'Optimizer',
  checkpointIncludesOptimizer: '含む',
  checkpointExcludesOptimizer: '含まない',
  checkpointFramework: 'Framework',
  checkpointResume: 'このcheckpointから再開',
  checkpointResumeTitle: 'checkpointから再開',
  checkpointResumeLatest: '最新checkpointから再開',
  checkpointResumeLatestMessage:
    'このJobのRunで保存された最新（stepが最大）のcheckpointから、新しいRunとして学習を再開します。',
  checkpointResumeKeepsSourceRun: '元のRunとそのcheckpointは変更されません。',
  checkpointResumeSubmit: '新しいRunで再開',
  checkpointResumeNoJob: 'このRunを実行したJobが見つからないため、ここからは再開できません。',
  checkpointResumedBadge: '再開',
  checkpointResumedBadgeHint: 'checkpointから再開したRunのJobです',
  checkpointSourceRun: '元のRun',
} as const;

// Text that embeds values; merged into catalog's textTemplates.
export const checkpointsTextTemplates = {
  checkpointResumedFromStep: (step: number) => `step ${step} のcheckpointから再開`,
  checkpointResumeMessage: (step: number) =>
    `step ${step} のcheckpointから、新しいRunとして学習を再開します。`,
  checkpointFileCount: (count: number) => `${count} ファイル`,
};

export const checkpointSourceLabels: Record<RunCheckpointSource, string> = {
  native: 'SDK',
  mlflow: 'MLflow',
};
