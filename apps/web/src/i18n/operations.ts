import type { OperationsAlertKind } from '@mmt/contracts';

// The operations alert badge in the header and the plugin delivery status.
export const operationsText = {
  operationsAlerts: '運用アラート',
  operationsAlertsNone: '開いている運用アラートはありません',
  operationsAlertsLoadFailed: '運用アラートを読み込めませんでした',
  operationsAlertOpenedAt: '検知',
  pluginOutbox: 'イベントの送信状況',
  pluginOutboxPending: '未送信',
  pluginOutboxSending: '送信中',
  pluginOutboxOldestPending: '最古の未送信',
  pluginOutboxMaxAttempts: '最多の試行回数',
  pluginOutboxLastError: '最終エラー',
  pluginOutboxLastDelivered: '最終送信',
  pluginOutboxStalled:
    '送信が滞留しています（15分以上未送信、または5回以上失敗）。Pluginの状態を確認し、復旧後に「イベントを再送」を押してください。',
} as const;

export const operationsAlertKindLabels: Record<OperationsAlertKind, string> = {
  'job.heartbeat_stale': 'Jobのheartbeat途絶',
  'worker.offline': 'workerの停止',
  'plugin.delivery_stalled': 'Plugin送信の滞留',
};

export const operationsTextTemplates = {
  operationsAlertCount: (count: number) => `運用アラート ${count}件`,
};
