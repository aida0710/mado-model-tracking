# 外部の計算機（site）

siteは、スーパーコンピュータやSSHで入るGPUサーバーのように、trackingが直接は操作しない計算機です。trackingが持つのは、名前・CPU・使えるruntime・投入方式だけです。接続先、スケジューラのoption、鍵はsiteの側（サイトrepoの`job.sh`とlauncherの設定）に置きます。投入はlauncher（ログインに一時パスワードが要るsiteでは本人の`mado-tracking submit`）が行い、計算ノードのrunnerがJob tokenでtrackingへ直接報告します。

APIの詳細は[api-contract.md](api-contract.md)の「外部の計算機（site）」、設計の背景は[設計案](design/external-execution.md)、job shellと設定の例は[deploy/sites](../deploy/sites/README.md)、Pythonのコマンドは[python/README.md](../python/README.md)の「外部の計算機（site）」にあります。

## 流れ

1. 研究者がJob（またはarray）を作ります。画面、SDK、フック、ドライバーのどれからでも同じです。
2. launcherが投入を受け取り（claim）、siteのログインノードに仕様の置き場を書いて、siteの`job.sh`を1回実行します。`job.sh`はスケジューラへ投入し、標準出力の最後の行にジョブIDを出します。
3. 計算ノードでrunnerが起動し、入力を用意し、コンテナを動かし、出力をuploadして、Jobを終えます。報告はすべてJob tokenで、runner用の公開hostname（[deploy/edge](../deploy/edge/README.md)）を通ります。
4. trackingはJobの段階（`phase`）を画面に出します。Runは、コンテナが動き始めた時点で`running`になります。

| 段階 | 画面の表示 | 意味 |
|---|---|---|
| （なし） | 待機中 | launcherの投入待ち |
| `waiting_manual` | 手動投入待ち | 本人の`mado-tracking submit`待ち |
| `submitting` | 投入中 | job shellを実行中 |
| `submitted` | 待ち行列 | スケジューラの待ち行列 |
| `waiting_resources` | 準備・GPU待ち | runnerが入力を用意し、空きGPUを待っています |
| `running` | 実行中 | コンテナが動いています |

終わったJobの理由（`endReason`）は、時間切れ（`timed_out`）、待ち行列の上限（`queue_timeout`）、投入失敗（`submit_failed`）のどれかです。

## 管理者: siteを登録する

Compute画面（全体管理者）か`POST /api/targets`で登録します。

| 項目 | 内容 |
|---|---|
| `executor` | `site` |
| `runtimeKinds` | `docker`・`singularity`・`apptainer`から。Apptainer/Singularityだけのsiteでも、runnerがdockerのimageをSIFへ変換するので、dockerのCodeを動かせます |
| `cpuArch` | 計算ノードのCPU（`amd64`か`arm64`。GH200などは`arm64`） |
| `submissionMode` | `automatic`（launcherが投入）か`manual`（本人が`mado-tracking submit`で投入） |
| `supportsArray` | スケジューラのarrayに投入できるsiteなら`true`。arrayの全員を1回の投入にまとめます |
| `maxConcurrentJobs` | 同時に投入中・実行中にしておく数（arrayに対応するsiteのarrayは1つと数えます） |
| `queueTimeoutSeconds` | 待ち行列でこれより長く待ったJobを失敗にします（60秒〜30日、省略で無制限） |

siteには接続先・鍵・GPU ID・Python runtimeを登録しません（入れると422）。入力は、runnerがJob tokenで直接取得します（`datasetTransfer`は`direct`）。trackingはsiteに接続しないので、接続確認のボタンは押せません。

## 管理者: siteの側を用意する

1. **サイトrepo**: 管理者だけが変更できるgit repo（Forgejoなど）に、[deploy/sites/examples](../deploy/sites/README.md)から近い方式の`job.sh`と`site.toml`を写し、キュー名・資源タイプ・グループ・pathをサイトの資料に合わせて書き換えます。PBS（ABCI 3.0）、Slurm、Grid Engine（TSUBAME4.0）、Fujitsu TCS（富岳）、スケジューラのないDocker・Apptainerのホストの例があります。例の`job.sh`は、依頼の値を検証してから別々の引数でスケジューラへ渡し、スケジューラの自動再実行を止め、時間切れの前にrunnerへSIGTERMが届くようにしています。
2. **launcher**: `docker compose --profile launcher up -d launcher`で動かします。`launcher.toml`の`[[projects]]`に、ProjectごとのService Accountのtoken（`read`と`worker:execute`）を入れたファイルを、`[[sites]]`に`site.toml`の内容を並べます。共用アカウントのsiteと、本人のアカウントで投入するsite（`account_mode = "personal"`、`[sites.accounts."<メールアドレス>"]`）があります。
3. **runner用の公開hostname**: 計算ノードがLANの外にあるときは、[deploy/edge](../deploy/edge/README.md)のnginx設定で、Job tokenの要求と署名付きwebhookだけを通すhostnameを用意し、`site.toml`の`runner_api_url`に書きます。
4. **ログインに一時パスワードが要るsite**: `submissionMode`を`manual`にします。launcherは投入しません。研究者が自分のPCからではなく、siteのログインノードで`mado-tracking submit`を実行します（次の節）。

## 研究者: siteで動かす

- **image**: CodeVersionのdockerのimageは`image@sha256:<digest>`で固定します。`mado-tracking code register --job-file mmt-job.toml`は、`mmt-job.toml`に書いたtagをregistryに問い合わせてdigestに直してから登録します。imageはsiteの`cpuArch`向けにbuildします（Apple Siliconで作るimageは`arm64`です。x86のsiteには`docker buildx build --platform linux/amd64`で作ります）。土台には[公式のbase image](../images/base/README.md)を使えます。サーバーの`MMT_IMAGE_PLATFORM_CHECK=enforce`では、CPUの合わないimageのJobは保存の時点で422になります。
- **GPUと時間**: siteのJobはGPUを数（`gpuCount`）で求め、時間の上限（`walltimeSeconds`）を付けられます。どのGPUを使うかはスケジューラ（直実行のホストではrunner）が決めます。
- **再実行**: `retryOnTimeout`のJobは、時間切れで終わると最新のcheckpointから、`retryOnFailure`のJobは失敗すると同じ開始点から、`maxAttempts`まで自動で再実行します。
- **array**: 同じCodeを番号ごとに動かすときは`POST /api/projects/:p/job-arrays`かSDKの`create_job_array`を使います。`datasetPartitionVersionId`に入力の版を指定すると、runnerはファイルをpath順に並べて`位置 % 個数 == 番号`のファイルだけを用意します（音声3000時間を64人で分けるなど）。arrayに対応するsiteでは、1回の投入（OTPのsiteでは1回のログイン）で全員を投入します。
- **手動投入**: Jobsの画面に手動投入待ちの案内が出たら、siteのログインノードで実行します。

  ```bash
  export MMT_API_URL=https://tracking.example.org MMT_API_TOKEN=<自分のAPI token>
  mado-tracking submit --site <siteのID> --dry-run    # 待っている件数だけ見る
  mado-tracking submit --site <siteのID> --job-shell ~/mmt/job.sh --work-dir /work/<group>/<me>/mmt --var GROUP=<group>
  ```

  siteごとの既定値は`~/.config/mado-tracking/submit.toml`の`[sites."<siteのID>"]`に書けます。tokenは`jobs:write`（件数の表示には`read`も）を持つ本人のAPI tokenです。何も常駐しません。

## runner

runnerは`mado-tracking site-run <仕様の置き場>`で、launcherと`submit`がsiteの作業ディレクトリへzipapp（`.mmt-runner/<版>/mmt-runner.pyz`）として置きます。計算ノードにはPython 3.11以上が要ります。

| 仕様の置き場のファイル | 内容 |
|---|---|
| `submission.json` | 投入の内容（tokenを含まない） |
| `api.json` | runnerが報告するAPIのURL（`apiUrl`） |
| `runner.json` | 作業ディレクトリ、GPUの割り当て方（`scheduler`か`lease`）、取消の猶予など |
| `jobs/<番号>.json` | 番号ごとのWorkerJobとJob token（600） |
| `secrets.json` | 任意。registryの認証（SIFへの変換に使う） |

- 置き場は700、中のファイルは600です。job shellは値を環境変数（`MMT_SPEC_DIR`、`MMT_RUNNER`、`MMT_GPU_COUNT`、`MMT_WALLTIME`、`MMT_ARRAY_SIZE`、`MMT_JOB_IDS`、`MMT_VAR_*`など）で受け取り、tokenを引数やスケジューラのoptionに載せません。
- runnerは`MMT_ARRAY_INDEX`（無ければ0）番目のJobを動かし、5秒ごとにheartbeatを送ります。取り消されたらコンテナを止めて`canceled`、SIGTERM（時間切れ）ならコンテナを止めて`timed_out`で終えます。
- コンテナに渡すものはworkerと同じです（`/mmt/inputs`・`/mmt/outputs`・`result.json`、Job tokenの`MMT_API_TOKEN`、`MMT_PROJECT_ID`・`MMT_JOB_ID`）。フックの入力のcheckpointは`MMT_INPUT_CHECKPOINT_DIR`（ふつうは`/mmt/inputs/checkpoint`、再開のcheckpointもあるJobでは`/mmt/inputs/input-checkpoint`）、起動の内容は`MMT_TRIGGER_PAYLOAD_FILE`（`/mmt/context/trigger-payload.json`）で読めます。
- dockerのimageをApptainer/Singularityで動かすときは、`apptainer pull --arch <cpuArch>`でSIFへ変換し、`<作業ディレクトリ>/.mmt-cache/sif/`にimageとCPUの組ごとに1つだけ置いて使い回します。
- 終了コードは、成功0、失敗・取消・時間切れ1、設定の誤り2、Jobが既に終わっている・別のrunnerがいる・tokenが失効した3です。終わったJobのJob tokenは401になるので、応答が失われた終了報告を送り直すと3で終わります（Jobは終わっています）。

## 取消と期限

| 取り消したときの段階 | どうなるか |
|---|---|
| 投入前・手動投入待ち | すぐ取消 |
| 投入中・待ち行列 | すぐ取消。launcherがsiteの取消コマンド（`cancel_command`）で待ち行列から外します |
| 準備・GPU待ち、実行中 | runnerが次のheartbeatで気づき、コンテナを止めて取消 |

- 待ち行列の上限（`queueTimeoutSeconds`）を過ぎたJobは`queue_timeout`で失敗し、待ち行列から外されます。job shellの結果が15分届かない投入は`submit_failed`で失敗します。
- runnerが起動しないまま止まったbatch job（moduleが無いなど）は、trackingからは待ち行列にいるように見えます。`queueTimeoutSeconds`を設定し、原因は仕様の置き場の`scheduler.*.log`で確かめます。
- 手動投入のsiteには、待ち行列から外す仕組みがありません。取り消したJobのrunnerは、起動してもtokenが401になるのですぐ終わります。
- 親Job（ドライバー）を取り消すと、終わっていない子Jobも取り消します。

## まだ確かめていないこと

- 実際のスケジューラ（PBS・Slurm・Grid Engine・Fujitsu TCS）、OTPのあるsite、GH200（arm64）、実SSHでの投入。例の`job.sh`のoptionと資源タイプは各サイトの資料に基づく例です。
- 数千件のarrayの作成時間（1件ずつ検証して作るので、作成に数十秒かかる見込みです）。
- スケジューラのない直実行のホストでは、時間の上限をrunnerの起動から数えるので、GPUの空き待ちも含みます。runnerがSIGKILLで落ちると、Dockerのコンテナは残ります（GPUの割り当てでは使用中として扱います）。
- 計算ノードのPythonが3.11・3.12のとき、zipappにhttpxの依存が足りるか（3.13でだけ確かめました）。
