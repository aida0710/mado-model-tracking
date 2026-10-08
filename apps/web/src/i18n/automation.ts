import type { ModelAutomationExecution } from '@mmt/contracts';
import type { SourceRunSkipReason } from '../lib/automationSourceRunSkip';
import { text } from './catalog';

export const automationOutcomeLabels: Record<ModelAutomationExecution['status'], string> = {
  pending: '学習完了待ち',
  queued: text.automationQueued,
  failed: text.automationFailed,
  skipped: text.automationSkipped,
};

export const automationSourceRunSkipLabels: Record<SourceRunSkipReason, string> = {
  source_run_unsuccessful: '起動せず（学習Runが失敗・停止）',
  source_run_timeout: '起動せず（学習完了待ちの期限切れ）',
};

export const automationText = {
  sourceRun: '学習Runを開く',
  pendingHint: '学習Runが成功すると、その時点で有効なルールで起動します。',
};
