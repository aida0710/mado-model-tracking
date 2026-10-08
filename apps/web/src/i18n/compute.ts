import type {
  TargetCheckItemCode,
  TargetCheckItemName,
  TargetCheckItemStatus,
} from '@mmt/contracts';

// Worker presence, Job heartbeat and target connection check labels on the Compute and Jobs pages.
export const computeText = {
  workers: 'Workers',
  workerId: 'Worker ID',
  workerStatus: '接続状態',
  workerOnline: 'オンライン',
  workerOffline: 'オフライン',
  workerVersion: '版',
  workerHostname: 'ホスト名',
  workerToken: 'トークン',
  workerTargets: '対象target',
  workerAllTargets: 'すべて',
  workerLastSeen: '最終応答',
  workerActiveJobs: '担当Job数',
  noWorkers: 'このプロジェクトに接続したworkerはまだありません',
  workerOfflineHint: '120秒以上応答がありません',
  jobUnresponsive: '応答なし',
  jobUnresponsiveHint: '60秒以上heartbeatがありません。Jobの状態とGPUの予約は変えていません',
  datasetCacheMaxGiB: 'データセットのcache上限（GiB）',
  datasetTransfer: 'データセットの転送',
  datasetTransferRelay: 'workerが中継する',
  datasetTransferDirect: 'targetがAPIから直接取得する',
  checkTarget: '接続を確認',
  targetCheck: '接続確認',
  targetCheckHint:
    'targetを担当するworker（MMT_WORKER_TARGET_IDSに含むもの）がSSHで確認します。APIサーバーはtargetへ接続しません',
  targetCheckHintLocal:
    'targetを担当するworker（MMT_WORKER_TARGET_IDSに含むもの）が、自分のホスト上でコマンドを起動して確認します',
  targetCheckLocalConnection: 'コマンドの起動',
  targetLocationLocal: 'workerのホスト上',
  targetCheckNone: 'まだ接続確認をしていません',
  targetCheckWaiting: 'workerの応答を待っています',
  targetCheckRequestedAt: '依頼',
  targetCheckFinishedAt: '完了',
  targetCheckWorker: '確認したworker',
  targetCheckItem: '項目',
  targetCheckOutcome: '結果',
  targetCheckDetail: '詳細',
  targetCheckAction: '対処',
  targetCheckNoWorker:
    '5分以内にclaimしたworkerがありません。MMT_WORKER_TARGET_IDSにこのtargetを含むworkerが動いているか確認してください',
  targetCheckClaimTimeout: 'workerから結果が届きませんでした。workerのログを確認してください',
  targetCheckFreeSpace: '作業ディレクトリの空き',
  detectedGpus: '検出したGPU',
  gpuIndex: 'Index',
  gpuName: '名前',
  gpuMemory: 'メモリ',
  gpuUuid: 'UUID',
  noDetectedGpus: 'nvidia-smiはGPUを報告しませんでした',
  targetCheckCandidates: '設定の候補',
  targetCheckCandidatesHint:
    '確認結果から選んだ値です。保存するまでtargetの設定は変わりません',
  targetCheckCurrent: '現在',
  saveTargetCandidates: '選んだ候補を保存',
  targetCheckCandidatesSaved: 'targetの設定を保存しました',
};

export const targetCheckItemLabels = {
  connection: 'SSH接続',
  python: 'Python',
  venv: 'venv',
  pip: 'pip',
  git: 'git',
  docker: 'Docker',
  apptainer: 'Apptainer',
  singularity: 'Singularity',
  gpu: 'GPU（nvidia-smi）',
  work_directory: '作業ディレクトリ',
  api: 'APIへの到達',
} satisfies Record<TargetCheckItemName, string>;

export const targetCheckOutcomeLabels = {
  ok: 'OK',
  ng: 'NG',
  unavailable: 'なし',
  skipped: '未確認',
} satisfies Record<TargetCheckItemStatus, string>;

// One short fix per reason code; shown next to the failing item.
export const targetCheckCodeHints = {
  ssh_failed: 'host・port・username、鍵とknown_hostsの登録を確認してください',
  ssh_configuration:
    'workerホストに鍵かknown_hostsのファイルが無いか、鍵の権限が600ではありません（mado-tracking-worker doctorで確認できます）',
  connection_failed: 'workerがこのtargetのコマンドを起動できませんでした',
  probe_failed: '確認用スクリプトが動きませんでした。Python 3.11以上を指定してください',
  python_missing: 'pythonExecutableのパスにPythonがありません',
  python_too_old: 'Python 3.11以上をpythonExecutableに指定してください',
  venv_missing: 'venvモジュールを導入してください（Debian/Ubuntuはpython3-venv）',
  pip_missing: 'pipかensurepipを導入してください',
  git_missing: 'Git sourceのコードを実行するにはgitが必要です',
  docker_missing: 'Docker runtimeを使う場合はDockerを導入してください',
  docker_socket_denied: 'SSHユーザーをdockerグループに追加してください',
  docker_daemon_unreachable: 'Docker daemonが起動しているか確認してください',
  container_cli_missing: 'コンテナを使う場合は導入してください',
  container_flags_missing:
    'execに必要なオプション（--containall、--no-mount、--nvなど）がありません。新しい版へ更新してください',
  nvidia_smi_missing: 'GPUを使う場合はNVIDIAドライバとnvidia-smiを導入してください',
  nvidia_smi_failed: 'nvidia-smiが失敗しました。ドライバの状態を確認してください',
  work_directory_not_writable: 'SSHユーザーが書き込めるディレクトリを指定してください',
  api_unreachable:
    'targetからworkerのMMT_API_URLへ届きません。Jobの記録に必要なので経路とURLを確認してください',
} satisfies Record<TargetCheckItemCode, string>;
