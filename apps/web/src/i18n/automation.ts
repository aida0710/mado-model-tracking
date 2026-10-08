import type { ModelAutomationExecution, ModelAutomationRule } from '@mmt/contracts';
import type { AutomationSkipReason } from '../lib/automationSkipReason';
import { text } from './catalog';

export const automationOutcomeLabels: Record<ModelAutomationExecution['status'], string> = {
  pending: '学習完了待ち',
  queued: text.automationQueued,
  failed: text.automationFailed,
  skipped: text.automationSkipped,
};

export const automationSkipReasonLabels: Record<AutomationSkipReason, string> = {
  source_run_unsuccessful: '起動せず（学習Runが失敗・停止）',
  source_run_timeout: '起動せず（学習完了待ちの期限切れ）',
  upstream_unsuccessful: '起動せず（上流のRunが失敗・停止）',
  upstream_outputs_missing: '起動せず（上流のRunに出力データセットなし）',
};

export const automationTriggerLabels: Record<ModelAutomationRule['trigger'], string> = {
  model_registered: 'モデル登録',
  upstream_run_finished: '上流ruleの成功',
};

export const automationText = {
  sourceRun: '学習Runを開く',
  triggerRun: '上流のRunを開く',
  pendingHint: '学習Runが成功すると、その時点で有効なルールで起動します。',
  trigger: 'トリガー',
  upstreamRule: '上流rule',
  stage: '段',
  stageLabel: (stage: number) => `${stage}段目`,
  manual: '手動',
  attemptLabel: (attempt: number) => `${attempt}回目`,
  triggerError: 'トリガーを選択してください。',
  upstreamRequired: '上流ruleを選択してください。',
  upstreamInvalid: '同じプロジェクトの有効な別のruleを上流に選択してください。',
  reservedTag: (key: string) =>
    `tag「${key}」は使えません。automation. と mmt. で始まるtagはサーバーが付けます。`,
  applyToVersion: '既存の版に適用',
  applyVersion: '適用する版',
  applyUpstreamRun: '上流のRun',
  applyConfirm: '適用する',
  applyConfirmMessage: (ruleName: string, targetLabel: string) =>
    `「${ruleName}」を ${targetLabel} に適用し、Jobを登録します。`,
  applyNoVersions: '対象モデル系列の版がありません。',
  applyNoUpstreamRuns: '上流ruleが作ったRunがありません。',
  applyRunning: 'このruleと版の実行が進行中です。終わってから適用してください。',
  applyInvalidRule: 'このruleは適用できません。',
  applied: 'Jobを登録しました。自動実行履歴で状態を確認できます。',
  automaticRun: '自動',
};
