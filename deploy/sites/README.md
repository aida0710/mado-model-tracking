# サイトのjob shellとlauncher

外部実行（使い方は[docs/sites.md](../../docs/sites.md)、背景は[設計案](../../docs/design/external-execution.md)）で、計算機（site）ごとに使う`job.sh`の例と、launcherの起動設定の例です。計算機の接続先・アカウント・job shellは、trackingのWeb（Compute画面）で設定します。計算機を追加するとき、ここの`job.sh`を雛形として選べます。launcher（手動投入の計算機では本人の`mado-tracking submit`）は、投入のたびに、siteのログインノード（直実行ならそのホスト）でWebのjob shellの今の版を実行します。

`examples/`の値（キュー名、資源タイプ、グループの指定、hostname、path）はすべて例です。実際のサイトの資料で確かめてから使ってください。

| ファイル | 内容 |
|---|---|
| [examples/launcher.toml](examples/launcher.toml) | launcherの起動設定（`api_url`、`token_file`、`state_directory`、`poll_seconds`、任意の`registry_secret_file`） |
| `examples/<方式>/job.sh` | そのサイトのjob shell。Webの雛形はこのファイルをそのまま使います |
| `examples/<方式>/README.md` | job shellで書き換えるところと、Webの全体設定・自分の設定に入れる値 |

## 例の一覧

| ディレクトリ | 投入先 | arrayの指定 | 計算ノードでの番号 | 標準出力に出すID | 取消 |
|---|---|---|---|---|---|
| [pbs](examples/pbs/) | PBS Professional（ABCI 3.0の書き方） | `-J 0-(N-1)` | `PBS_ARRAY_INDEX` | `qsub`の出力（`12345.server`、arrayは`12345[].server`） | `qdel` |
| [slurm](examples/slurm/) | Slurm | `--array=0-(N-1)` | `SLURM_ARRAY_TASK_ID` | `sbatch --parsable`の出力（`;cluster`は外す） | `scancel` |
| [grid-engine](examples/grid-engine/) | Grid Engine（TSUBAME4.0の書き方） | `-t 1-N` | `SGE_TASK_ID`から1を引く | `qsub -terse`の出力（arrayは`.1-N:1`を外す） | `qdel` |
| [fujitsu-tcs](examples/fujitsu-tcs/) | Fujitsu TCS（富岳の書き方） | `--bulk --sparam 0-(N-1)` | `PJM_BULKNUM` | `pjsub`の`[INFO] ... Job <ID> submitted.`から取り出す | `pjdel` |
| [direct-docker](examples/direct-docker/) | スケジューラのないGPUホスト（Docker） | runnerをN個起動する | job shellが0から振る | 何も出さない | runnerがheartbeatで気づいて止める |
| [direct-apptainer](examples/direct-apptainer/) | スケジューラのないGPUホスト（Apptainer） | 同上 | 同上 | 何も出さない | 同上 |

雛形を選ぶと、job shellの内容のほか、取消コマンド・array・GPUの渡し方・runtimeが上の表の値になります。各例のREADMEの「Webに入れる値」は、そのほかの全体設定と、利用者が「自分の設定」に入れる値の例です。

## job shellの約束

launcherが渡す環境変数と、読み取る最後の行の決まりは[job_shell.py](../../python/src/mado_tracking/site/job_shell.py)が正本です。

| 環境変数 | 内容 |
|---|---|
| `MMT_SPEC_DIR` | このsubmissionの仕様の置き場（権限700。中のファイルは600） |
| `MMT_RUNNER` | runnerを起動する実行ファイル（引数は仕様の置き場） |
| `MMT_GPU_COUNT` | 1つのJobが要求するGPU数 |
| `MMT_WALLTIME_SECONDS`、`MMT_WALLTIME` | 制限時間（秒、`HH:MM:SS`。24時間を超えると`72:00:00`の形）。未指定なら空 |
| `MMT_ARRAY_SIZE` | arrayの大きさ（1つのJobなら1） |
| `MMT_JOB_IDS` | カンマ区切りのJob ID（arrayの番号順） |
| `MMT_PROJECT_ID`、`MMT_TARGET_ID` | 参照用 |
| `MMT_VAR_<名前>` | 全体設定の変数に、依頼者の「自分の設定」の変数を重ねたもの。例: `MMT_VAR_GROUP` |

- launcherはjob shellを、内容のhashごとに`<作業ディレクトリ>/.mmt-job-shells/<hash>/job.sh`へ置き、仕様の置き場をcurrent directoryにして実行します。値は`env NAME=value`で1つずつ渡り、シェルを通りません。
- 標準出力の最後の行に、スケジューラのジョブIDだけを出します。直実行のホストでは何も出しません。例のjob shellは、標準出力にIDの1行だけを出し、ほかの表示はすべて標準エラーへ出します。標準エラーの終わりの部分は、失敗の理由としてJobに残ります。
- 終了コードが0でなければ、投入の失敗（`submit_failed`）として報告されます。依頼の値が検証に通らないときも、投入せずに失敗します。
- arrayは`MMT_ARRAY_SIZE`が2以上のときだけ使います。計算ノード側で、スケジューラの番号を0始まりの`MMT_ARRAY_INDEX`に直してから`exec "$MMT_RUNNER" "$MMT_SPEC_DIR"`します（1つのJobなら0）。
- 取消コマンド（全体設定）は、job shellが出したIDを`MMT_SCHEDULER_JOB_ID`で受け取ります。arrayのIDを渡すと、全員が待ち行列から外れます。
- job shellは`sh job.sh`でも、ファイルとして直接でも、標準入力から（`sh -s`）でも動きます。スケジューラのコマンドには標準入力を渡しません。

## 安全のための決まり

- 依頼の値は環境変数だけで受け取り、スクリプトの文字列に埋め込みません（`eval`もしません）。job shellが書き出すbatch script（`$MMT_SPEC_DIR/batch.sh`、直実行は`run.sh`）は定数の文字列で、計算ノードで環境変数から値を読みます。
- 値はスケジューラへ渡す前に検証します。数は符号と先頭の0のない10進数、pathは英数字と`._/+@-`だけ、グループ名などは英数字と`._-`だけです。オプションの値は別々の引数として渡し、シェルを通しません。
- tokenなどの秘密は仕様の置き場のファイル（600）にだけあります。引数、スケジューラのオプション（`qsub -v`など）、環境変数には載りません。そのため、ジョブへ環境変数を渡しても秘密は渡りません。PBSとGrid Engineの例は`-v`で渡す名前をpathと数に限り、SlurmとTCSの例は投入時の環境をそのまま渡します（`--export=ALL`、`-X`）。
- job shellはコンテナの外で、投入したアカウントの権限で動きます。job shellと全体設定を変えられるのは計算機の所有者と全体管理者（全体の計算機は全体管理者）だけで、保存のたびに新しい版になり、監査ログ（`site.job_shell.create`）に残ります。共用アカウントのホストでは、job shellが他の人のJobの秘密ファイルも読めます（利用者どうしは隔離しません）。
- 本人のアカウントで投入する計算機では、所有者のjob shellが各利用者のアカウントで動きます。trackingの全体管理者の権限（またはtrackingのDB）を得た人も、job shellを書き換えて同じことができます。launcherの公開鍵を登録する前に、そのことを利用者に伝えてください。サイトが許せば、authorized_keysの行の先頭に`from="<launcherのホストのアドレス>"`を付けると、鍵が漏れても他のホストからは使えません。
- スケジューラの自動再実行は止めます（PBSとGrid Engineは`-r n`、Slurmは`--no-requeue`、TCSは`--norestart`）。再実行はtrackingが行います。スケジューラが同じJobをもう一度起動しても、2つ目のrunnerは`runner_conflict`で拒否されます。

## 時間切れの扱い

runnerはSIGTERMを受けるとコンテナを止め、`endReason: 'timed_out'`でJobを終えます（`retryOnTimeout`の対象）。スケジューラごとに、制限時間に達したときの合図が違うので、例のjob shellで次のように合わせています。

| 投入先 | 制限時間に達したとき | 例のjob shellがすること |
|---|---|---|
| PBS | SIGTERM、`kill_delay`の後にSIGKILL | runnerを`exec`し、SIGTERMを直接受けさせる |
| Slurm | SIGTERM、`KillWait`の後にSIGKILL | `--signal=B:TERM@120`で、制限時間の120秒前にrunnerへSIGTERMを送らせる |
| Grid Engine | `h_rt`で予告なしにSIGKILL | batch scriptのtimerが、制限時間の120秒前にrunnerへSIGTERMを送る。batch scriptが受けたSIGTERMもrunnerへ渡す |
| Fujitsu TCS | ジョブの全プロセスへSIGXCPU、10秒後にSIGKILL | runnerはSIGXCPUを無視する状態で起動し、batch scriptがSIGXCPUをSIGTERMに置き換えて渡す。120秒前のtimerもある |
| 直実行 | スケジューラがない | `timeout`が制限時間でrunnerへSIGTERMを送る。制限時間はrunnerの起動から数えるので、GPUの空き待ちも含む |

予告の秒数は`TIMEOUT_NOTICE_SECONDS`（Slurmはjob shell、Grid EngineとTCSはbatch scriptの中）で変えます。

## runnerが起動しなかったとき

trackingへ報告するのはrunnerだけです。batch scriptがrunnerを起動する前に止まると（moduleが無い、pathが見えないなど）、Jobは「投入済み」のまま残ります。投入済みのJobには応答途絶の判定をしないためです。

- 計算機の「待ち行列の上限」（`queueTimeoutSeconds`）を設定すると、上限を過ぎたJobは失敗（`queue_timeout`）になります。
- 原因は`$MMT_SPEC_DIR/scheduler.*.log`（直実行は`runner.<番号>.log`）に残ります。仕様の置き場は`<作業ディレクトリ>/.mmt-submissions/<最初のJob ID>`です。
- 例のbatch scriptは、runnerを起動する前の処理を最小限にしています。書き換えるときも、runnerの前に失敗しうる処理を増やさないでください。runnerの実行ファイルが無いときは、ログインノードのjob shellが投入の前に失敗にします。

## launcherの起動設定（launcher.toml）

launcherは起動に要るものだけを1つのTOMLから読みます（`mado-tracking-launcher --config <path>`か`MMT_LAUNCHER_CONFIG`）。担当の計算機の設定・job shell・鍵の依頼・接続確認は、巡回のたびに`GET /api/launcher/config`で読むので、Webで変えても再起動は要りません。読み方の正本は`python/src/mado_tracking/site/launcher_config.py`です。

| 項目 | 内容 |
|---|---|
| `api_url` | launcherから見たAPIのURL（composeの中なら`http://api:4182`） |
| `token_file` | 全体管理者がCompute画面の「launcher」で登録したときに一度だけ出るtokenを、それだけ入れたファイル（mode 600） |
| `state_directory` | launcherが作った秘密鍵、siteのknown_hosts、投入中の記録と未送信の報告の置き場。再起動しても同じ場所にし、launcherごとに分けます |
| `poll_seconds` | 巡回の間隔（秒、既定10） |
| `registry_secret_file` | 任意。全siteのrunnerがimageをSIFへ変換するときに使う、読み取り専用tokenのJSON（`{"username", "password"}`、mode 600） |

- tokenとregistryのファイルは、launcherの実行ユーザーが所有し、groupとotherが読めないようにします（そうでなければlauncherが拒みます）。
- launcherのtokenは`/api/launcher/*`にしか届きません。どのProjectのJobでも、担当の計算機（Webでそのlauncherを選んだ計算機）への投入を受け取ります。Projectごとのtokenは要りません。
- 古い形式（`launcher_id`、`[[projects]]`、`[[sites]]`）の設定は、起動の時点で拒みます。計算機ごとの値はWebの全体設定へ移してください。

## 鍵と接続確認

自動投入の計算機では、launcherがログイン用の鍵（ed25519）を`<state_directory>/keys/<鍵のID>`に作り、公開鍵だけをAPIへ送ります。秘密鍵はlauncherのホストから出ません。

| アカウント方式 | 鍵 | 公開鍵を登録する人 |
|---|---|---|
| 共用 | 計算機に1つ | 所有者（全体の計算機では全体管理者）が、共用アカウントの`~/.ssh/authorized_keys`へ |
| 本人 | 利用者ごとに1つ（「自分の設定」でアカウント名を保存したとき） | 各利用者が、自分のアカウントへ（サイトの利用者ポータルなど） |

- 公開鍵の注記は`mmt-launcher:<launcherの名前>:<鍵のID>`です。authorized_keysの中で、どのlauncherのどの鍵かを見分けられます。
- 「接続確認」を押すと、launcherが次の巡回でその鍵とアカウントでsiteへログインし、`true`だけを実行して結果を返します。5分答えがなければ失敗になります（launcherが止まっている、など）。
- 鍵を作り直すと、古い鍵はすぐ失効し、launcherが手元のファイルも消します。新しい公開鍵を登録し直すまで、そのアカウントへの投入は失敗します。
- 状態の置き場を失うと、launcherは同じ鍵のIDで鍵を作り直し、新しい公開鍵を送ります（監査ログ`site.key.publish`）。登録し直すまで投入は失敗します。
- known_hostsはWebの全体設定のものだけを使います（`<state_directory>/known-hosts/<計算機のID>`へ書き出します）。`ssh-keyscan`の出力は、サイトが公開しているホスト鍵の指紋と照らしてから貼ってください。

## 手動投入の計算機（`mado-tracking submit`）

投入方式が「手動」の計算機には、launcherは投入しません。ログインに一時パスワード（OTP）が要るsiteや、launcherから入れないPCです。Jobを依頼した本人が、その計算機の上で自分のAPI token（`MMT_API_URL`、`MMT_API_TOKEN`）を使って実行します。

```sh
mado-tracking submit --site <計算機のID> --dry-run      # 待っている件数と設定を見る
mado-tracking submit --site <計算機のID>                # 待っている自分のJobを1回投入する
mado-tracking submit --site <計算機のID> --watch        # 止めるまで繰り返す（PC）
mado-tracking submit --site <計算機のID> --watch --all  # 所有者: 共有した計算機の全員のJob
```

- job shell・作業ディレクトリ・runnerのPython・変数は、Webの全体設定と自分の設定から読みます。設定ファイルは要りません。`--work-dir`と`--var NAME=VALUE`は、その回だけ上に重ねます。
- `--watch`は`--interval`（既定10秒）ごとに繰り返し、SIGINTかSIGTERMで止まります。`--watch`を使わなければ何も常駐しません。
- `--all`は計算機の所有者だけが使えます。所有者のPCの上で、所有者のアカウントで全員のJobを動かすので、共有する相手を選んでください。

## サイトで試す

ダミーの仕様置き場と、受け取った値を表示するだけのrunnerで、job shellを手で動かします。`<作業ディレクトリ>`は全体設定（または自分の設定）の作業ディレクトリです。

```sh
mkdir -m 700 <作業ディレクトリ>/try-spec
printf '#!/bin/sh\necho "index=$MMT_ARRAY_INDEX spec=$1"\n' > <作業ディレクトリ>/try-runner
chmod 700 <作業ディレクトリ>/try-runner
env MMT_SPEC_DIR=<作業ディレクトリ>/try-spec MMT_RUNNER=<作業ディレクトリ>/try-runner \
  MMT_GPU_COUNT=0 MMT_ARRAY_SIZE=2 MMT_WALLTIME=00:05:00 MMT_WALLTIME_SECONDS=300 \
  MMT_JOB_IDS=00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002 \
  MMT_VAR_GROUP=<グループ> sh job.sh
```

最後の行がジョブIDだけで、ジョブが終わった後に`<作業ディレクトリ>/try-spec/scheduler.*.log`へ`index=0 ...`と`index=1 ...`が出れば、約束どおりです。取消は`MMT_SCHEDULER_JOB_ID=<ID> sh -c '<取消コマンド>'`で確かめます。

## launcherをDocker composeで動かす

`compose.yml`の`launcher`（profile `launcher`、[Dockerfile.launcher](../../Dockerfile.launcher)）です。

```bash
docker compose --profile launcher build launcher
docker compose --profile launcher up -d launcher
docker compose --profile launcher logs -f launcher
```

| 設定 | 既定 | containerの中 | 内容 |
|---|---|---|---|
| `MMT_LAUNCHER_CONFIG_DIR` | `./var/launcher-config` | `/etc/mado-tracking-launcher`（read-only） | `launcher.toml`を置くディレクトリ |
| `MMT_LAUNCHER_SECRETS_DIR` | `./var/launcher-secrets` | `/run/secrets/mado-tracking-launcher`（read-only） | `token_file`と`registry_secret_file`のファイル |
| `MMT_LAUNCHER_UID`、`MMT_LAUNCHER_GID` | `10002` | — | 上のファイルの所有者に合わせてbuildします |
| volume `launcher-state` | — | `/var/lib/mado-tracking-launcher` | `launcher.toml`の`state_directory`にします。消すと、投入中の記録と未送信の報告を失い、鍵も作り直しになります |

- composeの中から同じホストのAPIを使うときは、`api_url = "http://api:4182"`です。runnerに渡すURLは、計算機ごとの「runnerから見たAPIのURL」です。
- 動かす前に`docker compose --profile launcher run --rm launcher --once`で、1回だけ巡回を試せます。
