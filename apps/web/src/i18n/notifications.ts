import type {
  NotificationChannelKind,
  NotificationDeliveryStatus,
  NotificationEventType,
} from '@mmt/contracts';

// Notification channels, rules and the delivery history in the Project settings.
export const notificationsText = {
  notifications: '通知',
  notificationsDescription:
    'Runの失敗などをSlackやWebhookへ通知します。通知先は全体管理者が登録し、どのイベントを送るかはProject adminがルールで決めます。',
  notificationChannels: '通知先',
  newNotificationChannel: '通知先を追加',
  editNotificationChannel: '通知先を変更',
  notificationChannelsEmpty: '使える通知先はまだありません',
  notificationChannelKind: '種類',
  notificationChannelScope: '使えるProject',
  notificationScopeGlobal: 'すべてのProject',
  notificationScopeProject: 'このProjectだけ',
  notificationDestination: '送信先',
  notificationConfigured: '環境変数',
  notificationConfiguredYes: '設定済み',
  notificationConfiguredNo: '未設定',
  notificationUrlEnv: 'URLを参照する環境変数名（MMT_NOTIFICATION_で始まる）',
  notificationSecretEnv: '署名の鍵を参照する環境変数名（MMT_NOTIFICATION_で始まる）',
  notificationRecipients: '宛先のメールアドレス（1行に1件）',
  notificationChannelHint:
    'URLと署名の鍵はAPI serverの環境変数に置き、ここには変数名だけを登録します。値は画面にもDBにも保存しません。',
  notificationEmailHint: 'メールの送信はSMTPの設定が入るまで行われず、送信履歴に失敗として残ります。',
  notificationTest: 'テスト送信',
  notificationTestDelivered: 'テスト送信が届きました',
  notificationTestFailed: 'テスト送信に失敗しました',
  notificationRules: '通知ルール',
  newNotificationRule: '通知ルールを作成',
  notificationRulesEmpty: '通知ルールはまだありません',
  notificationRuleChannel: '通知先',
  notificationRuleEvents: '通知するイベント',
  notificationRuleFilter: '条件',
  notificationRuleFilterNone: 'すべて',
  notificationRuleRunKinds: 'Runの実行種別（未選択ならすべて）',
  notificationRuleExperiments: '実験（未選択ならすべて）',
  notificationRuleAutomationOnly: '自動実行が起動したRunだけ',
  notificationRuleFixedSettings:
    '作成後は有効・無効のみ変更できます。条件を変える場合は新しいルールを作成してください。',
  notificationRuleChannelRequired: '通知先を選択してください',
  notificationRuleEventsRequired: '通知するイベントを1つ以上選択してください',
  notificationEnable: '有効にする',
  notificationDisable: '無効にする',
  notificationDeliveries: '直近の送信履歴',
  notificationDeliveriesEmpty: '送信履歴はまだありません',
  notificationDeliveryEvent: 'イベント',
  notificationDeliveryAttempts: '試行回数',
  notificationDeliveryError: '失敗の理由',
  notificationDeliveryCreatedAt: '発生日時',
} as const;

export const notificationChannelKindLabels: Record<NotificationChannelKind, string> = {
  slack_webhook: 'Slack（Incoming Webhook）',
  webhook: 'Webhook（署名付き）',
  email: 'メール',
};

export const notificationEventTypeLabels: Record<NotificationEventType, string> = {
  'run.failed': 'Runの失敗',
  'run.canceled': 'Runの中止',
  'run.finished': 'Runの完了',
  'automation.failed': '自動実行の失敗',
  'job.heartbeat_stale': 'Jobのheartbeat途絶',
  'job.heartbeat_recovered': 'Jobのheartbeat復旧',
  'worker.offline': 'workerの停止',
  'plugin.delivery_stalled': 'Plugin送信の滞留',
};

export const notificationDeliveryStatusLabels: Record<NotificationDeliveryStatus, string> = {
  pending: '送信待ち',
  sending: '送信中',
  delivered: '送信済み',
  failed: '失敗',
};

export const notificationsTextTemplates = {
  notificationRuleFilterRunKinds: (kinds: string) => `実行種別: ${kinds}`,
  notificationRuleFilterExperiments: (count: number) => `実験: ${count}件`,
  notificationTestError: (code: string) => `テスト送信に失敗しました（${code}）`,
};
