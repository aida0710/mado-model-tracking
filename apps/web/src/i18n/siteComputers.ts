import type {
  SiteAccountMode,
  SiteConnectionCheckStatus,
  SiteGpuAssignment,
  SiteKeyStatus,
} from '@mmt/contracts';
import type { JobShellTemplateKey } from '../lib/jobShellTemplates';

// Computers added on the Web: the site settings of the target dialog, the owner in the lists, and
// a site's details (job shell, keys and checks, personal settings, submit).
export const siteComputersText = {
  siteSubmissionSection: '投入と接続',
  siteExecutionSection: 'siteでの実行',
  siteAdvancedSettings: '詳細',
  jobShellSection: 'job shell',
  launcherId: 'ランチャー',
  launcherUnset: '（選んでください）',
  noLaunchersNotice:
    'ランチャーはまだ登録されていません。全体管理者が「全体管理」の「ランチャー」で登録します。',
  siteHost: '接続先のhost',
  sitePort: '接続先のport',
  siteJumpHosts: '経由するホスト（1行に1つ、[user@]host[:port]）',
  siteKnownHosts: 'known_hosts（接続先と経由するホストの行）',
  siteKnownHostsHint:
    'known_hostsは、ssh-keyscanの出力をホスト鍵の指紋で確かめてから貼ります。ランチャーはここに無いホスト鍵を受け入れません。',
  accountMode: 'ログインするアカウント',
  sharedAccount: '共用アカウント名',
  siteWorkDirectory: '作業ディレクトリ（計算ノードからも同じパスで見える絶対パス）',
  runnerPython: 'runnerのPython（3.11以上）',
  runnerApiUrl: 'runnerから見たAPIのURL（任意）',
  runnerApiUrlPlaceholder: 'https://mmt-runner.example.org',
  cancelCommand: '取消コマンド（任意。MMT_SCHEDULER_JOB_IDを読む）',
  gpuAssignment: 'GPUの渡し方',
  leaseGpuIds: '選んでよいGPU（1行に1つ。空ならすべて）',
  siteVariables: '変数（NAME=VALUEを1行に1つ。job shellにはMMT_VAR_NAMEで渡ります）',
  maxActiveSubmissions: '1回に受け取る数',
  cancelGraceSeconds: '取消の猶予（秒）',
  maxOutputFiles: '出力の上限（1つのJobのファイル数）',
  siteExecutionHint:
    'runnerから見たAPIのURLが空なら、ランチャー（手動投入ではmado-tracking submit）が使うURLを渡します。本人のアカウントで投入するコンピュータと手動投入のコンピュータでは、作業ディレクトリと変数を各自の「自分の設定」で置き換えられます（共用アカウントのコンピュータでは置き換えません）。',
  jobShellTemplate: 'job shellの雛形',
  jobShellTemplateNone: '雛形を使わない',
  jobShellTemplateHint:
    '雛形を選ぶと、job shellの内容と、取消コマンド・array・GPUの渡し方・対応Runtimeが雛形の値になります。雛形は例なので、キュー名・資源・グループなどをsiteの資料に合わせて書き換えてください。',
  jobShell: 'job shell',
  siteLauncherRequired: '自動投入のコンピュータには、投入するランチャーを選んでください。',
  siteHostError:
    '接続先のhostは、英数字と「.」「:」「_」「-」だけで入力してください（先頭に「-」は使えません）。',
  siteKnownHostsRequired:
    'known_hostsを入力してください。ランチャーは知らないホスト鍵を受け入れません。',
  siteKnownHostsLineError:
    'known_hostsの各行は「ホスト 鍵の種類 鍵」の形にしてください（#で始まる行は注釈です）。',
  siteSharedAccountRequired: '共用アカウント名を入力してください。',
  siteAccountNameRequired: 'あなたのアカウント名を入力してください。',
  siteAccountNameError:
    'アカウント名は英数字か「_」で始め、英数字と「.」「_」「-」だけで64文字までにしてください。',
  siteWorkDirectoryError:
    '作業ディレクトリは「/」で始まる絶対パスを、英数字と「._/+@-」だけで入力してください。',
  siteWorkDirectoryRequired: '共用アカウントのコンピュータには、作業ディレクトリを入力してください。',
  runnerPythonError:
    'runnerのPythonは、英数字と「._/+@-」だけのコマンド名かパスで入力してください。',
  runnerApiUrlError:
    'runnerから見たAPIのURLは、http://かhttps://で始まるURLで入力してください。',
  jobShellRequired: 'job shellを入力するか、雛形を選んでください。',
  // The owner column: a computer from before owners is everyone's (global administrators manage it).
  targetOwnerGlobal: '全体',
  targetOwnerSelf: '自分',
  jobShellCurrent: '今のバージョン',
  jobShellNone: 'job shellがまだありません。保存するまで、このコンピュータのJobは投入されません。',
  jobShellEdit: 'job shellを編集',
  jobShellSave: '新しいバージョンとして保存',
  jobShellLoadTemplate: '雛形を読み込む',
  jobShellLoadTemplateHint:
    '雛形を読み込むと、編集中の内容を置き換えます。取消コマンドなどの設定は変わりません（コンピュータの編集で変えます）。',
  jobShellUnchanged: '内容が今のバージョンと同じなので、新しいバージョンは作りませんでした。',
  jobShellHistory: 'バージョンの履歴',
  jobShellHistoryHint: 'Jobは投入に使ったバージョンを記録します。保存したバージョンは変わりません。',
  jobShellVersion: 'バージョン',
  jobShellCreatedBy: '保存した人',
  jobShellCreatedAt: '保存日時',
  jobShellShow: '表示',
  jobShellShowCurrent: '今のバージョンを表示',
  siteKeysTitle: '鍵と接続確認',
  siteKeysNoLauncher:
    'ランチャーを選んでいないため、鍵はまだ作られません。コンピュータの編集でランチャーを選んでください。',
  siteKeyRequested:
    'ランチャーが鍵を作るのを待っています。ランチャーが次に設定を読むと公開鍵が出ます。',
  siteKeyNone: '鍵はまだありません。',
  siteKeyFingerprint: '指紋',
  siteKeyStatus: '鍵の状態',
  siteKeyReadyAt: '作成日時',
  siteKeyRequestedAt: '依頼日時',
  siteKeyRotate: '鍵を作り直す',
  siteKeyRequest: '鍵を依頼する',
  siteKeyRotateConfirm:
    '今の鍵を失効させ、ランチャーに新しい鍵を作らせます。新しい公開鍵をauthorized_keysに登録し直すまで、このアカウントへの投入は失敗します。',
  siteConnectionCheckHint:
    'ランチャーがこの鍵とアカウントでsiteへ1回ログインし、trueだけを実行します。Jobは投入しません。',
  siteConnectionChecks: '確認の結果',
  siteConnectionCheckNone: 'まだ確認していません。',
  siteConnectionCheckMessage: 'ランチャーの報告',
  sitePersonalTitle: '自分の設定',
  sitePersonalHint:
    'このコンピュータであなたのJobを投入するときに使う設定です。空の項目はコンピュータの設定を使います。',
  sitePersonalSharedAccountNotice:
    'このコンピュータは共用アカウントで動くので、自分の設定はありません。全員のJobを同じアカウント・作業ディレクトリ・変数で投入します。',
  siteAccountName: 'あなたのアカウント名',
  siteAccountRequiredNotice:
    'このコンピュータは本人のアカウントで投入します。アカウント名を保存するまで、このコンピュータでJobを作れません。保存すると、ランチャーがあなた用の鍵を作ります。',
  sitePersonalWorkDirectory: '作業ディレクトリ（任意。コンピュータの設定を置き換えます）',
  sitePersonalVariables: '変数（任意。NAME=VALUEを1行に1つ。コンピュータの変数より優先します）',
  sitePersonalSave: '自分の設定を保存',
  sitePersonalSaved: '自分の設定を保存しました。',
  sitePersonalDelete: '自分の設定を消す',
  sitePersonalDeleteConfirm:
    '自分の設定を消します。本人のアカウントで投入するコンピュータでは、あなた用の鍵も失効し、設定し直すまでJobを作れません。',
  sitePersonalNone: 'まだ保存していません。',
  sitePersonalKeyTitle: 'あなた用の鍵',
  sitePersonalListTitle: '利用者の設定',
  sitePersonalListUser: '利用者',
  sitePersonalListAccount: 'アカウント',
  sitePersonalListVariables: '変数',
  sitePersonalListKey: '鍵',
  sitePersonalListUpdatedAt: '更新',
  sitePersonalListEmpty: 'このコンピュータの設定を保存した人はまだいません。',
  siteUsesComputerSetting: 'コンピュータの設定',
  manualGuideTitle: 'mado-tracking submitで投入する',
  manualGuideHint:
    'このコンピュータには手動で投入します。Jobを依頼した本人が、そのコンピュータで次のコマンドを実行します（本人のAPI tokenを使います）。',
  manualGuideOnce: 'ログインノードで、待っている自分のJobを1回投入する',
  manualGuideWatch: 'PCで待ち受ける（止めるまで繰り返し投入する）',
  manualGuideAll:
    '所有者: Publicにしたコンピュータで、ほかの人のJobも待ち受けて投入する（あなたのアカウントで動きます）',
  manualGuideAllScope:
    '--allで受け取るのは、使ったtokenのProjectのJobです。複数のProjectのJobを受け取るときは、Projectごとに、そのProjectのtokenで--watch --allを動かします。',
  manualGuideToken:
    '実行する前に、MMT_API_URLと、jobs:writeを持つ本人のAPI token（MMT_API_TOKEN）を設定します。',
} as const;

// Text that embeds values.
export const siteComputersTextTemplates = {
  // Someone else's manual computer may be their PC (they take everyone's Jobs) or, for example, a
  // supercomputer each requester submits to with their own account.
  manualGuideOwnerSubmits: (owner: string) =>
    `このコンピュータは${owner}さんのコンピュータです。所有者が--watch --allで待ち受けているコンピュータ（所有者のPCなど）では、所有者の側で投入されます。`,
  siteJumpHostError: (value: string) =>
    `経由するホスト「${value}」は[user@]host[:port]の形で入力してください。`,
  siteJumpHostsTooMany: (max: number) => `経由するホストは${max}個までです。`,
  siteKnownHostsTooLarge: (kib: number) => `known_hostsは${kib} KiB以下にしてください。`,
  siteVariableLineError: (line: string) =>
    `変数「${line}」はNAME=VALUEの形にしてください（NAMEは英字か「_」で始まる英数字と「_」）。`,
  siteVariableDuplicate: (name: string) => `変数${name}が2回あります。`,
  siteVariablesTooMany: (max: number) => `変数は${max}個までです。`,
  siteNumberRangeError: (label: string, min: number, max: number) =>
    `${label}は${min}〜${max}の整数で入力してください。`,
  jobShellTooLarge: (mib: number) => `job shellは${mib} MiB以下にしてください。`,
  jobShellVersionLabel: (version: number) => `v${version}`,
  jobShellShowing: (version: number) => `バージョン${version}を表示しています`,
  jobShellSaved: (version: number) => `バージョン${version}を保存しました。これからの投入に使います。`,
  siteSharedKeyHint: (account: string) =>
    `ランチャーが作った公開鍵です。共用アカウント（${account}）の~/.ssh/authorized_keysに1行で追加してください。秘密鍵はランチャーのホストから出ません。`,
  sitePersonalKeyHint: (account: string) =>
    `ランチャーがあなた用に作った公開鍵です。あなたのアカウント（${account}）の~/.ssh/authorized_keysに1行で追加してください。秘密鍵はランチャーのホストから出ません。`,
};

export const siteAccountModeLabels = {
  shared: '共用のアカウント（全員のJobを1つのアカウントで投入します）',
  personal: '本人のアカウント（各自が「自分の設定」に書いたアカウントで投入します）',
} satisfies Record<SiteAccountMode, string>;

export const siteGpuAssignmentLabels = {
  scheduler: 'スケジューラが割り当てる',
  lease: 'runnerがホストの空いたGPUから選ぶ（スケジューラが無いホスト）',
} satisfies Record<SiteGpuAssignment, string>;

export const jobShellTemplateLabels = {
  pbs: 'PBS Professional（ABCI 3.0の例）',
  slurm: 'Slurm（共用アカウントの例）',
  'grid-engine': 'Grid Engine（TSUBAME4.0の例）',
  'fujitsu-tcs': 'Fujitsu TCS（富岳の例）',
  'direct-docker': 'スケジューラなしのGPUホスト（Docker）',
  'direct-apptainer': 'スケジューラなしのGPUホスト（Apptainer）',
} satisfies Record<JobShellTemplateKey, string>;

export const siteKeyStatusLabels = {
  requested: '作成待ち',
  ready: '作成済み',
} satisfies Record<SiteKeyStatus, string>;

export const siteConnectionCheckStatusLabels = {
  queued: '確認中',
  succeeded: '成功',
  failed: '失敗',
} satisfies Record<SiteConnectionCheckStatus, string>;
