import {
  HOOK_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  MAX_JOB_CHAIN_DEPTH,
  type HookCheckpointMode,
  type HookConcurrency,
  type HookExecutionStatus,
  type HookExecutionSubject,
  type HookSkipReason,
  type HookTrigger,
  type HookWebhookSignature,
} from '@mmt/contracts';

const SECONDS_PER_MINUTE = 60;

// The Hooks screen: the list, the create dialog, a hook's settings, manual starts and executions.
export const hooksText = {
  hooks: 'Hooks',
  hookList: 'フック',
  hookExecutions: '実行履歴',
  newHook: 'フックを作成',
  noHooks: 'フックはまだありません',
  noHookExecutions: '実行履歴はまだありません',
  hookTrigger: 'きっかけ',
  hookOwner: '所有者',
  hookOwnerHint: 'フックはこの所有者の権限でJobを起動し、作るRunの作成者になります。',
  hookTransferNoAccounts:
    'ほかに移管できるService Accountがありません。移管先はプロジェクト設定でrole editorかadminの有効なService Accountとして作成します。',
  hookFilter: 'きっかけの絞り込み',
  hookFilterHint:
    '空の項目では絞り込みません。条件に合わないイベントでは起動せず、実行履歴も残しません。',
  hookFilterModelFamilies: 'モデル系列',
  hookFilterExperiments: '実験',
  hookFilterRunKinds: 'Runの実行種別',
  hookFilterRunStatuses: 'Runの終了状態',
  hookFilterTags: 'Runのタグ（JSON・すべて一致）',
  hookNoFilter: '絞り込みなし',
  hookTemplate: '起動するJob',
  hookModelVersion: 'モデル版',
  hookInheritModelVersion: 'きっかけのRunのモデル版を使う',
  hookRegisteredModelVersion: '登録されたモデル版で起動します。',
  hookInheritOutputDatasets: 'きっかけのRunの出力データセット版も入力にする',
  hookArraySize: 'arrayの個数（任意。空なら1つのJob）',
  hookDatasetPartition: 'arrayで分ける入力データセット版（任意・ファイルを持つ版）',
  hookCheckpointMode: 'checkpointごとの起動',
  hookCheckpointEvery: '何個ごとに起動するか',
  hookConcurrency: '前のJobが終わる前のイベント',
  hookMaxStartsPerHour: '1時間あたりの起動回数の上限',
  hookLimits: '起動の制限',
  hookResources: 'Jobごとの資源',
  hookWebhookSignature: '署名の形式',
  hookFixedSettings:
    '作成後は有効・無効だけを変更できます。設定を変えるときは新しいフックを作成してください。',
  hookEnabled: '有効',
  hookDisabled: '無効',
  hookStart: '手動で起動',
  hookStartPayload: '本文（JSON・任意）',
  hookStartPayloadHint:
    'Jobの中では/mmt/context/trigger-payload.json（環境変数MMT_TRIGGER_PAYLOAD_FILE）として読めます。',
  hookStartConfirm: '起動する',
  hookWebhookCreated: 'Webhookの設定',
  hookWebhookSecret: '署名の秘密鍵',
  hookWebhookPath: '受け口のpath',
  hookWebhookSecretOnce:
    '秘密鍵はこの画面で一度だけ表示します。閉じると二度と表示できません。送信元に設定してから閉じてください。',
  hookWebhookPathHint:
    'APIを公開しているホストにこのpathを付けたURLを、送信元に登録します。署名が合わない要求と、無効にしたフックへの要求は受け付けません。',
  hookManualSiteNotice:
    'この実行先は手動投入のsiteです。フックが作ったJobは、所有者がsiteのログインノードでmado-tracking submitを実行するまで待機します。',
  hookExecutionSubject: '対象',
  hookExecutionOutcome: '結果',
  hookExecutionLinks: '関連',
  hookExecutionWaitingRun: '待っているRun',
  hookExecutionRequestedBy: '起動した人',
  hookAllHooks: 'すべてのフック',
  hookShowExecutions: '実行履歴を見る',
  hookViewFilter: '表示するフック',
  hookNameError: 'フックの名前を入力してください。',
  hookTriggerError: 'きっかけを選択してください。',
  hookTargetError: '選択したコード版のRuntimeに対応する有効な実行先を選択してください。',
  hookCodeError: '実行種別とモデル系列に対応するコード版を選択してください。',
  hookReferenceError: 'このプロジェクトの実験、モデル版、データセット版を選択してください。',
  hookPartitionError:
    'arrayで分ける入力データセット版は、arrayの個数を指定したうえで、ファイルを持つ版から選択してください。',
  hookSignatureError: '署名の形式を選択してください。',
} as const;

export const hookTriggerLabels: Record<HookTrigger, string> = {
  manual: '手動・起動API',
  model_registered: 'モデル版の登録',
  run_finished: 'Runの終了',
  array_finished: 'arrayの終了',
  checkpoint_saved: 'checkpointの保存',
  webhook: '外部webhook',
};

export const hookCheckpointModeLabels: Record<HookCheckpointMode, string> = {
  every: '毎回',
  every_k: 'k個ごと',
  latest: '最新だけ（評価中に増えた分は最新の1つにまとめる）',
  skip_if_running: '実行中なら飛ばす',
};

export const hookConcurrencyLabels: Record<HookConcurrency, string> = {
  queue: 'すべて起動する',
  skip_if_running: '前のJobが終わるまで起動しない',
};

export const hookWebhookSignatureLabels: Record<HookWebhookSignature, string> = {
  github: 'GitHub（X-Hub-Signature-256）',
  mmt: 'MMT（X-MMT-Signature）',
};

// How the sender signs each delivery, shown next to the secret right after creation.
export const hookWebhookSignatureHints: Record<HookWebhookSignature, string> = {
  github:
    'GitHubのWebhookでは、Content typeをapplication/jsonにし、この秘密鍵をSecretに設定します。X-GitHub-Deliveryが同じ再送は1回として扱います。',
  mmt: `送信元は、X-MMT-Signature: t=<unix秒>,v1=<HMAC-SHA256(秘密鍵, "<t>.<本文>")の16進>と、重複判定に使うX-MMT-Deliveryを付けて送ります。時刻のずれは${HOOK_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS / SECONDS_PER_MINUTE}分まで受け付けます。`,
};

export const hookExecutionStatusLabels: Record<HookExecutionStatus, string> = {
  pending: 'Runの終了待ち',
  queued: 'Jobを登録',
  skipped: '起動せず',
  failed: '起動に失敗',
};

export const hookSkipReasonLabels: Record<HookSkipReason, string> = {
  loop_detected: '同じ連鎖でこのフックが起動済み',
  chain_too_deep: `連鎖の深さが上限（${MAX_JOB_CHAIN_DEPTH}段）を超える`,
  rate_limited: '1時間あたりの起動回数の上限',
  already_running: '前のJobが終わっていない',
  owner_access_revoked: '所有者がプロジェクトの権限を失っている',
  superseded: '新しいcheckpointに置き換え',
  source_run_unsuccessful: 'きっかけのRunが失敗・停止',
  source_run_timeout: 'Runの終了待ちの期限切れ',
  hook_disabled: 'フックが無効',
};

export const hookExecutionSubjectLabels: Record<HookExecutionSubject, string> = {
  manual: '手動',
  model_version: 'モデル版',
  run: 'Run',
  array_group: 'array',
  checkpoint: 'checkpoint',
  webhook: 'webhook',
};

// Text that embeds values.
export const hooksTextTemplates = {
  hookSkipped: (reason: string) => `起動せず（${reason}）`,
  hookTransferConfirm: (hookName: string, accountName: string) =>
    `「${hookName}」の所有者を ${accountName} に移します。以後のフックの起動はこのService Accountの権限で行います。`,
  hookEnableConfirm: (name: string) =>
    `「${name}」を有効にします。以後のイベントで、所有者の権限でJobを起動します。`,
  hookDisableConfirm: (name: string) =>
    `「${name}」を無効にします。以後のイベントでは起動しません。待っている実行も起動しなくなります。`,
  hookStartConfirm: (name: string) =>
    `「${name}」を起動し、所有者の権限でJobを登録します。`,
  hookCheckpointEveryError: (max: number) =>
    `何個ごとに起動するかは1〜${max}の整数で指定してください。`,
  hookMaxStartsError: (max: number) =>
    `1時間あたりの起動回数の上限は1〜${max}の整数で指定してください。`,
  hookPayloadTooLarge: (maxKiB: number) => `本文は${maxKiB}KiB以内にしてください。`,
  hookCheckpointEveryK: (every: number) => `${every}個ごと`,
  hookStarted: (outcome: string) =>
    `起動を受け付けました（${outcome}）。その後の結果は実行履歴で確認できます。`,
};
