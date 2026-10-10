# 外部の計算機（site）

siteは、スーパーコンピュータ、SSHで入るGPUサーバー、研究者のPCのように、launcher（ログインに一時パスワードが要るsiteやlauncherから入れないPCでは本人の`mado-tracking submit`）がjob shellで投入する計算機です。計算機はWebから足します。全体管理者は全員で使う計算機を、研究者は自分の計算機を足します。接続先・job shell・個人設定はtrackingに保存し、SSHの鍵はlauncherが自分のホストで作ります（trackingには公開鍵だけがあります）。計算ノードのrunnerはJob tokenでtrackingへ直接報告します。

APIの詳細は[api-contract.md](api-contract.md)の「外部の計算機（site）」、設計の背景は[設計案](design/external-execution.md)、job shellの雛形とlauncherの起動設定は[deploy/sites](../deploy/sites/README.md)、Pythonのコマンドは[python/README.md](../python/README.md)の「外部の計算機（site）」にあります。

## 流れ

1. 研究者がJob（またはarray）を作ります。画面、SDK、フック、ドライバーのどれからでも同じです。
2. launcherが投入を受け取り（claim）、siteのログインノードに仕様の置き場を書いて、その計算機のjob shell（Webで保存した今の版）を1回実行します。job shellはスケジューラへ投入し、標準出力の最後の行にジョブIDを出します。Jobには、使ったjob shellの版が残ります。
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

## 計算機を足す（Web）

Compute画面の「計算機を追加」から足します（APIは`POST /api/targets`）。

| 誰が | 足せるもの | 使える人 |
|---|---|---|
| 全体管理者 | 全体の計算機（ssh・local・site） | どのProjectの人も |
| 研究者 | 自分の計算機（siteだけ） | 本人と、本人が共有したProject（本人がeditor以上のもの）のメンバー |

Jobを作る画面の実行先には、そのProjectで自分が使える計算機だけが出ます。共有していない他の人の計算機には、Jobを作れません（422 `target_not_available`）。

共有された計算機を使うことは、その所有者を信頼することです。所有者はjob shellとrunnerのAPIのURLを決め、計算機の上ではJobの仕様の置き場（Job tokenを含む）も読めます。Job tokenはそのJobのRunにしか書けませんが、Projectのデータは読めます。

### 計算機の説明

| 項目 | 内容 |
|---|---|
| 投入方式 | 自動（launcherがSSHで入って投入）か、手動（本人が`mado-tracking submit`で投入。OTPのsite、launcherから入れないPC） |
| CPU | 計算ノードのCPU（`amd64`か`arm64`。GH200などは`arm64`） |
| runtime | `docker`・`singularity`・`apptainer`から。Apptainer/Singularityだけのsiteでも、runnerがdockerのimageをSIFへ変換するので、dockerのCodeを動かせます |
| array | スケジューラのarrayに投入できるjob shellなら有効。arrayの全員を1回の投入にまとめます |
| 同時に動かす数 | 投入中・実行中にしておく数（arrayに対応するsiteのarrayは1つと数えます） |
| 待ち行列の上限 | 待ち行列でこれより長く待ったJobを失敗にします（60秒〜30日、省略で無制限） |

### 全体設定

| 項目 | 内容 |
|---|---|
| launcher | 自動投入のsiteを担当するlauncher（全体管理者が登録したもの） |
| 接続先 | ログインノードのhost・port、経由するホスト（`[user@]host[:port]`、1行に1つ）、known_hosts（接続先と経由するホストの全部。launcherは知らないhost keyを受け入れません） |
| アカウント方式 | 共用（全員が1つのアカウントで動く。アカウント名を入れる）か本人（依頼した人の個人設定のアカウントで動く）。手動投入のsiteは、投入した本人のアカウントで動きます |
| 作業ディレクトリ | 計算ノードからも見える場所。本人アカウントのsiteと手動投入のsiteでは、各人が個人設定で自分の場所を入れられます |
| runnerのPython | 計算ノードのPython 3.11以上（既定`python3`） |
| runnerから見たAPIのURL | 計算ノードがLANの外なら、runner用の公開hostname（[deploy/edge](../deploy/edge/README.md)） |
| 取消コマンド | 待ち行列から外すコマンド（例: `qdel "$MMT_SCHEDULER_JOB_ID"`）。スケジューラのないホストでは不要 |
| GPUの渡し方 | スケジューラが選ぶか、スケジューラのないホストでrunnerが空いたGPUを選ぶか（選んでよいGPUを入れられます） |
| 変数 | job shellへ渡す`MMT_VAR_<名前>`（`NAME=VALUE`を1行に1つ）。本人アカウントのsiteと手動投入のsiteでは、個人設定の変数が上書きします |

### job shell

追加のときに雛形（PBS（ABCI 3.0）・Slurm・Grid Engine（TSUBAME4.0）・Fujitsu TCS（富岳）・スケジューラのないDocker・Apptainerのホスト）を選ぶと、job shellと全体設定の既定値が入ります。キュー名・資源タイプ・グループ・pathをサイトの資料に合わせて直します。job shellの約束（受け取る環境変数、最後の行に出すジョブID、安全のための決まり）は[deploy/sites](../deploy/sites/README.md)にあります。

job shellは保存のたびに新しい版になり、古い版は変わりません。以後の投入は今の版を使い、Jobには使った版が残ります。job shellと全体設定を変えられるのは、計算機の所有者と全体管理者だけです（全体の計算機は全体管理者だけ）。job shellはログインノードでそのアカウントの権限で動くので、変更は監査ログ（`site.job_shell.create`）に残ります。

### 鍵と個人設定

自動投入のsiteでは、launcherがログイン用の鍵を作り、公開鍵を計算機の詳細に出します。秘密鍵はlauncherのホストから出ません。

- **共用アカウント**: 所有者（全体の計算機では全体管理者）が、出た公開鍵を共用アカウントの`~/.ssh/authorized_keys`に登録します。この計算機は全体設定だけで動き、利用者の「自分の設定」はありません（利用者が作業ディレクトリや変数を変えると、共用アカウントで他の人の場所に書けてしまうため）。
- **本人アカウント**: 各研究者が計算機の「自分の設定」でアカウント名（と必要なら作業ディレクトリ・`GROUP`などの変数）を保存すると、launcherがその人用の鍵を作ります。出た公開鍵を、サイトの利用者ポータルなどで自分のアカウントに登録します。個人設定が無い人は、このsiteにJobを作れません（422 `site_account_required`）。
- 本人アカウントの計算機と手動投入の計算機では、所有者が決めたjob shellが、あなたのアカウントで動きます。本人アカウントの計算機に公開鍵を登録すると、所有者と全体管理者は、job shellを書き換えてあなたのアカウントで何でも実行できるようになります。手動投入では、`mado-tracking submit`が実行のたびに今の版を使います（`--dry-run`で版を確かめられます）。他の研究者の計算機を使う前に、その人を信頼できるか確かめてください。
- 手動投入の計算機では、`mado-tracking submit`を実行した人の個人設定（作業ディレクトリ・変数）を使います。所有者が`--all`で全員のJobを投入するときも、所有者の設定です。
- 登録できたかは「接続確認」で確かめます。launcherがその鍵とアカウントでログインし、`true`だけを実行します。
- 鍵を作り直すと古い鍵は失効し、新しい公開鍵を登録し直します。launcherの状態の置き場を失った場合も、launcherが鍵を作り直します。
- サイトの利用規程で、他のホストからの自動ログインや追加の公開鍵の登録が許されるか確かめてください。許されないsiteは手動投入にします。

### 計算機の種類ごとの手順

| 計算機 | 投入方式 | アカウント | 雛形 | 研究者がすること |
|---|---|---|---|---|
| 共用アカウントのスパコン・GPUサーバー | 自動 | 共用 | スケジューラの雛形か直実行 | 何もしない |
| 本人アカウントのスパコン（OTPなし） | 自動 | 本人 | スケジューラの雛形 | 自分の設定でアカウント名を保存し、公開鍵をサイトに登録する |
| OTPのスパコン（Miyabiなど） | 手動 | — | スケジューラの雛形 | ログインノードで`mado-tracking submit --site <ID>` |
| 研究室のGPUサーバー（launcherから入れる） | 自動 | 共用か本人 | 直実行 | 自分の計算機として足し、共有するProjectを選ぶ |
| 自分のPC（launcherから入れない） | 手動 | — | 直実行 | 自分の計算機として足し、PCで`mado-tracking submit --site <ID> --watch`を動かしておく（共有したら`--all`で全員のJobを投入） |

直実行の雛形はLinux（`nvidia-smi`・`setsid`・`timeout`）を前提にしています。Macではそのままでは動きません。

## 管理者: launcherを用意する

1. Compute画面の「launcher」で登録します。tokenは一度だけ表示されるので、launcherのホストのtokenファイル（mode 600）にすぐ写します。
2. launcherを`docker compose --profile launcher up -d launcher`で動かします。起動設定はAPIのURL・tokenファイル・状態の置き場だけです（[deploy/sites](../deploy/sites/README.md)）。担当の計算機の設定・job shell・鍵の依頼は、巡回のたびにAPIから読みます。設定を変えても再起動は要りません。
3. 計算ノードがLANの外にあるときは、[deploy/edge](../deploy/edge/README.md)のnginx設定で、Job tokenの要求と署名付きwebhookだけを通すhostnameを用意し、計算機の「runnerから見たAPIのURL」に書きます。
4. 状態の置き場（launcherの鍵を含む）はvolumeに残します。消すと鍵を作り直すことになり、公開鍵を登録し直します。tokenが漏れたら「tokenの作り直し」で古いtokenを止めます。
5. launcherを失効させると、それを選んでいる計算機には新しいJobを作れなくなります（422 `site_launcher_missing`）。待っているJobは、計算機の編集で別のlauncherを選ぶと投入されます。別のlauncherを選ぶと鍵も作り直しになるので、公開鍵を登録し直します。

launcherのtokenは、launcherのAPI（`/api/launcher/*`）にしか届きません。どのProjectのJobでも、担当の計算機への投入を受け取ります。

## 研究者: siteで動かす

- **image**: CodeVersionのdockerのimageは`image@sha256:<digest>`で固定します。`mado-tracking code register --job-file mmt-job.toml`は、`mmt-job.toml`に書いたtagをregistryに問い合わせてdigestに直してから登録します。imageはsiteの`cpuArch`向けにbuildします（Apple Siliconで作るimageは`arm64`です。x86のsiteには`docker buildx build --platform linux/amd64`で作ります）。土台には[公式のbase image](../images/base/README.md)を使えます。サーバーの`MMT_IMAGE_PLATFORM_CHECK=enforce`では、CPUの合わないimageのJobは保存の時点で422になります。
- **GPUと時間**: siteのJobはGPUを数（`gpuCount`）で求め、時間の上限（`walltimeSeconds`）を付けられます。どのGPUを使うかはスケジューラ（直実行のホストではrunner）が決めます。
- **再実行**: `retryOnTimeout`のJobは、時間切れで終わると最新のcheckpointから、`retryOnFailure`のJobは失敗すると同じ開始点から、`maxAttempts`まで自動で再実行します。
- **array**: 同じCodeを番号ごとに動かすときは`POST /api/projects/:p/job-arrays`かSDKの`create_job_array`を使います。`datasetPartitionVersionId`に入力の版を指定すると、runnerはファイルをpath順に並べて`位置 % 個数 == 番号`のファイルだけを用意します（音声3000時間を64人で分けるなど）。arrayに対応するsiteでは、1回の投入（OTPのsiteでは1回のログイン）で全員を投入します。
- **手動投入**: Jobsの画面に手動投入待ちの案内が出たら、siteのログインノード（自分のPCなら、そのPC）で実行します。job shellと作業ディレクトリ・変数は、Webの全体設定と自分の設定から読みます。

  ```bash
  export MMT_API_URL=https://tracking.example.org MMT_API_TOKEN=<自分のAPI token>
  mado-tracking submit --site <siteのID> --dry-run    # 待っている件数だけ見る
  mado-tracking submit --site <siteのID>              # 自分のJobを投入して終わる
  mado-tracking submit --site <siteのID> --watch      # 止めるまで待ち受ける（自分のPC）
  mado-tracking submit --site <siteのID> --watch --all  # 自分の計算機を共有したとき、全員のJobを投入する
  ```

  tokenは`jobs:write`（件数の表示には`read`も）を持つ本人のAPI tokenです。`--watch`を使わなければ何も常駐しません。

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
| 投入中・待ち行列 | すぐ取消。launcher（今その計算機を担当しているもの）が、全体設定の取消コマンドで待ち行列から外します |
| 準備・GPU待ち、実行中 | runnerが次のheartbeatで気づき、コンテナを止めて取消 |

- 待ち行列の上限（`queueTimeoutSeconds`）を過ぎたJobは`queue_timeout`で失敗し、待ち行列から外されます。job shellの結果が15分届かない投入は`submit_failed`で失敗します。
- runnerが起動しないまま止まったbatch job（moduleが無いなど）は、trackingからは待ち行列にいるように見えます。`queueTimeoutSeconds`を設定し、原因は仕様の置き場の`scheduler.*.log`で確かめます。
- 手動投入のsiteには、待ち行列から外す仕組みがありません。取り消したJobのrunnerは、起動してもtokenが401になるのですぐ終わります。
- 親Job（ドライバー）を取り消すと、終わっていない子Jobも取り消します。

## まだ確かめていないこと

- 実際のスケジューラ（PBS・Slurm・Grid Engine・Fujitsu TCS）、OTPのあるsite、GH200（arm64）、実SSHでの投入、launcherが作った鍵での実際のログイン。雛形のoptionと資源タイプは各サイトの資料に基づく例です。
- 数千件のarrayの作成時間（1件ずつ検証して作るので、作成に数十秒かかる見込みです）。
- スケジューラのない直実行のホストでは、時間の上限をrunnerの起動から数えるので、GPUの空き待ちも含みます。runnerがSIGKILLで落ちると、Dockerのコンテナは残ります（GPUの割り当てでは使用中として扱います）。
- 計算ノードのPythonが3.11・3.12のとき、zipappにhttpxの依存が足りるか（3.13でだけ確かめました）。
