import type {
  SweepMethod,
  SweepObjective,
  SweepStatus,
  SweepStatusReason,
  SweepTrialState,
} from '@mmt/contracts';
import type { SearchSpaceRowKind } from '../lib/sweepConfig';

// Sweeps: the list, the create dialog with its search space editor, and the detail page.
export const sweepsText = {
  sweeps: 'Sweeps',
  sweepNew: 'Sweepを作成',
  sweepNone: 'Sweepはまだありません',
  sweepTask: 'Task',
  sweepMethod: '探索方法',
  sweepTrials: '試行数',
  sweepTrialList: '試行',
  sweepRunningTrials: '実行中',
  sweepBestObjective: '最良の目的値',
  sweepCreatedBy: '作成者',
  sweepTaskRevisionPinned: 'Taskの現在のrevisionを固定して実行します。作成後にTaskを編集すると、Sweepは停止します。',
  sweepExperiment: 'Experiment',
  sweepExperimentHint: '試行のRunはTaskのExperimentに入ります。',
  sweepTarget: 'Compute target',
  sweepTaskDefault: 'Taskの既定',
  sweepGpuIds: 'GPU ID（カンマ区切り。空はTaskの既定）',
  sweepObjective: '目的',
  sweepObjectiveMetric: '目的メトリクス',
  sweepObjectiveMetricHint: '候補はTaskの過去のRunで記録されたメトリクスです。',
  sweepGoal: '方向',
  sweepAggregation: '試行の値の決め方',
  sweepMaxTrials: '最大試行数',
  sweepParallelism: '並列数',
  sweepSeed: 'Seed（空はサーバーが決める）',
  sweepEarlyStopping: '早期打ち切り',
  sweepEarlyStoppingNone: 'なし',
  sweepEarlyStoppingHyperband: 'Hyperband',
  sweepMinIter: 'min_iter',
  sweepEta: 'eta',
  sweepMaxIter: 'max_iter（任意）',
  sweepSearchSpace: '探索空間',
  sweepEditorRows: '行で編集',
  sweepEditorJson: 'W&B形式のJSON',
  sweepJsonHint:
    'W&Bのsweep config（method、metric、parameters、early_terminate、run_cap、parallelism）を貼り付けて読み込みます。未対応のキーはエラーになります。',
  sweepJsonLoad: '読み込む',
  sweepParameterName: 'parameter名',
  sweepParameterKind: '種類',
  sweepParameterValues: '値（カンマ区切り）',
  sweepParameterValue: '値',
  sweepDistribution: '分布',
  sweepMin: 'min',
  sweepMax: 'max',
  sweepQ: 'q',
  sweepAddParameter: 'parameterを追加',
  sweepRemoveParameter: 'parameterを削除',
  sweepGridContinuous: 'gridでは範囲のparameterを使えません。値か定数にしてください。',
  sweepNameRequired: 'parameter名を入力してください',
  sweepNameDuplicate: '同じparameter名があります',
  sweepValuesRequired: '値を1つ以上入力してください',
  sweepValueRequired: '値を入力してください',
  sweepNumberRequired: 'min・maxには数値を入力してください',
  sweepQNumber: 'qには数値を入力してください',
  sweepNoParameters: 'parameterを1つ以上追加してください',
  sweepObjectiveRequired: '目的メトリクスを入力してください',
  sweepSeedError: '0以上の整数を入力してください',
  sweepStatusReason: '理由',
  sweepProgress: '進み具合',
  sweepBestTrial: '最良試行',
  sweepNoBestTrial: '目的値のある完了した試行はまだありません',
  sweepPause: '一時停止',
  sweepResume: '再開',
  sweepCancel: 'Sweepを中止',
  sweepCancelConfirm: '新しい試行の投入をやめ、待機中の試行を止めます。',
  sweepCancelRunning: '実行中の試行にも停止を要求する',
  sweepChangeLimits: '試行数・並列数を変更',
  sweepResumeUnavailable: 'Taskが改訂されたため再開できません。新しいSweepを作成してください。',
  sweepProgressChart: '試行ごとの目的値',
  sweepBestSoFar: 'それまでの最良',
  sweepTrialObjective: '試行の目的値',
  sweepTrialIndex: '試行',
  sweepTrialState: '状態',
  sweepObjectiveValue: '目的値',
  sweepTrialRun: 'Run',
  sweepTrialJob: 'Job',
  sweepSortByTrial: '試行番号順',
  sweepSortByObjective: '目的値の良い順',
  sweepNoTrials: '試行はまだありません',
  sweepAnalysis: '分析',
  sweepObjectiveHistory: '試行の目的メトリクス',
  sweepDefinition: '定義',
  sweepSeedValue: 'Seed',
  sweepTaskRevision: 'Taskの改訂番号',
} as const;

// Text that embeds values; merged into catalog's textTemplates.
export const sweepsTextTemplates = {
  sweepTrialProgress: (created: number, maxTrials: number) => `${created} / ${maxTrials}`,
  sweepGridCombinations: (count: number) => `gridの組み合わせ: ${count}通り`,
  sweepGridTooMany: (count: number, limit: number) =>
    `gridの組み合わせ数は${limit}までです（${count}通り）。値を減らすか、randomかbayesにしてください。`,
  sweepTrialRunName: (trialIndex: number) => `#${trialIndex}`,
  sweepEarlyStoppedReason: (stopReason: string) => `打ち切り: ${stopReason}`,
  sweepSeriesLimited: (shown: number, total: number) =>
    `新しい${shown}件の試行だけを表示しています（全${total}件）。`,
  sweepConfigNotObject: (where: string) => `${where}はJSONオブジェクトで指定してください`,
  sweepConfigUnsupportedKeys: (where: string, keys: string[], allowed: string[]) =>
    `${where}の未対応のキー: ${keys.join(', ')}（使えるキー: ${allowed.join(', ')}）`,
  sweepConfigOneOf: (key: string, allowed: readonly string[]) =>
    `${key}は${allowed.join(' / ')}のどれかにしてください`,
  sweepConfigPositiveInteger: (key: string) => `${key}は1以上の整数にしてください`,
  sweepConfigNonEmptyString: (key: string) => `${key}は空でない文字列にしてください`,
  sweepConfigParameterValues: (name: string) =>
    `parameter「${name}」のvaluesは文字列・数値・真偽値の配列にしてください`,
  sweepConfigParameterValue: (name: string) =>
    `parameter「${name}」のvalueは文字列・数値・真偽値にしてください`,
  sweepConfigParameterNumbers: (name: string, keys: string) =>
    `parameter「${name}」の${keys}は数値にしてください`,
  sweepConfigParameterNested: (name: string) =>
    `parameter「${name}」: 入れ子のparametersには対応していません`,
  sweepConfigParameterLogUniform: (name: string) =>
    `parameter「${name}」: W&Bのlog_uniformは指数を渡す形式です。値そのものを渡すlog_uniform_valuesに書き換えてください`,
  sweepConfigParameterDistribution: (name: string, distribution: string) =>
    `parameter「${name}」: distribution「${distribution}」には対応していません`,
  sweepConfigParameterShape: (name: string) =>
    `parameter「${name}」にはvalues、value、またはminとmaxが必要です`,
  sweepConfigParameterName: () => 'parameter名は空でない文字列にしてください',
};

export const sweepStatusLabels: Record<SweepStatus, string> = {
  running: '実行中',
  paused: '一時停止',
  finished: '完了',
  canceled: '中止',
  failed: '失敗',
};

export const sweepStatusReasonLabels: Record<SweepStatusReason, string> = {
  user_requested: '利用者の操作',
  task_revision_changed: 'Taskが改訂された',
  owner_forbidden: '作成者がProjectのeditorではなくなった',
  launch_failed: '試行のJobを登録できなかった',
  max_trials_reached: '最大試行数に達した',
  search_space_exhausted: 'gridの組み合わせを使い切った',
  suggestion_failed: '次の試行を提案できなかった',
};

export const sweepTrialStateLabels: Record<SweepTrialState, string> = {
  queued: '待機中',
  running: '実行中',
  finished: '完了',
  failed: '失敗',
  canceled: '中止',
  early_stopped: '早期打ち切り',
};

export const sweepMethodLabels: Record<SweepMethod, string> = {
  grid: 'grid',
  random: 'random',
  bayes: 'bayes',
};

export const sweepGoalLabels: Record<SweepObjective['goal'], string> = {
  minimize: '最小化',
  maximize: '最大化',
};

export const sweepAggregationLabels: Record<SweepObjective['aggregation'], string> = {
  last: '最後の値（last）',
  min: '最小値（min）',
  max: '最大値（max）',
};

export const searchSpaceRowKindLabels: Record<SearchSpaceRowKind, string> = {
  values: '値の列挙',
  range: '範囲',
  constant: '定数',
};
