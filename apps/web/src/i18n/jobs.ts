import {
  MAX_JOB_ARRAY_SIZE,
  MAX_JOB_GPU_COUNT,
  type JobEndReason,
  type JobPhase,
  type LogEntry,
} from '@mmt/contracts';

// Jobs list and Run logs, with the site Job details (phase, scheduler, array, origin).
export const jobsText = {
  jobColumn: 'Job',
  jobRunColumn: 'Run',
  jobActions: '操作',
  logLevelAll: 'すべてのレベル',
  jobPhase: '段階',
  jobLauncherWaiting: '待機中（launcherの投入待ち）',
  jobEndReason: '終了の理由',
  jobWhere: '実行場所',
  jobOrigin: '起動元',
  schedulerJobId: 'スケジューラのジョブID',
  schedulerJobIdShort: 'ジョブID',
  jobSubmittedAt: '投入',
  runnerHost: 'runnerのホスト',
  jobSiteJobShell: 'job shellの版',
  parentJob: '親Job',
  jobHook: 'フック',
  jobArray: 'array',
  jobChainDepth: '連鎖の深さ',
  gpuCount: 'GPU数',
  walltime: '制限時間（HH:MM:SS・任意）',
  walltimeShort: '制限時間',
  walltimePlaceholder: '12:00:00',
  walltimeUnset: 'siteの既定',
  jobRetryOnFailure: '失敗したら最初から再実行する',
  jobRetryOnTimeout: '時間切れなら最新のcheckpointから再実行する',
  jobAllowChildJobs: 'このJobのコードから子Jobを作れる（ドライバー）',
  jobAutoRetry: '自動の再実行（最大試行回数まで）',
  manualSubmissionTitle: '手動投入を待っているJob',
  manualSubmissionHint:
    '依頼した本人がsite（ログインノードか、計算機にしたPC）で次のコマンドを実行すると、待っているJobが投入されます（本人のAPI tokenを使います）。PCを共有している所有者が--allで待ち受けていれば、所有者が投入します。',
  manualSubmissionOwnHint:
    'あなたが依頼したJobです。site（ログインノードか、計算機にしたPC）で次のコマンドを実行して投入してください（あなたのAPI tokenを使います）。',
  jobArrays: 'Job array',
  jobArraySize: '個数',
  jobArrayStates: '状態（番号ごとの最新の試行）',
  jobArrayShowJobs: 'Jobを表示',
  jobArrayShowAll: 'すべてのJobを表示',
  jobArrayCountsHint: '一覧に読み込んだJobから、番号ごとに最新の試行を数えます。',
  clockDurationError: '時間はHH:MM:SSの形（例: 12:00:00）で指定してください。',
  gpuCountError: `GPU数は0〜${MAX_JOB_GPU_COUNT}の整数で指定してください。`,
  arraySizeError: `arrayの個数は1〜${MAX_JOB_ARRAY_SIZE}の整数で指定してください。`,
  siteGpuIdsError: 'siteではGPU IDではなくGPU数を指定してください。',
} as const;

export const jobPhaseLabels: Record<JobPhase, string> = {
  waiting_manual: '手動投入待ち',
  submitting: '投入中',
  submitted: '待ち行列',
  waiting_resources: '準備・GPU待ち',
  running: '実行中',
};

export const jobEndReasonLabels: Record<JobEndReason, string> = {
  timed_out: '時間切れ',
  queue_timeout: '待ち行列の上限',
  submit_failed: '投入失敗',
};

// Text that embeds values.
export const jobsTextTemplates = {
  gpuCount: (count: number) => `GPU ×${count}`,
  arrayMember: (index: number, size: number) => `${index} / ${size}`,
  arraySize: (size: number) => `array ×${size}`,
  manualSubmissionWaiting: (siteName: string, count: number) => `${siteName}: ${count}件`,
  jobArrayFilter: (arrayId: string) => `array ${arrayId} のJobだけを表示しています。`,
  jobArrayState: (stateLabel: string, count: number) => `${stateLabel} ${count}`,
  walltimeError: (maxDays: number) =>
    `制限時間は${maxDays}日以内を、HH:MM:SSの形で指定してください。`,
};

export const logLevelLabels: Record<LogEntry['level'], string> = {
  info: '情報',
  warning: '警告',
  error: 'エラー',
};
