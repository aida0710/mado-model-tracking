# サイトのjob shellとlauncherの設定

外部実行（使い方は[docs/sites.md](../../docs/sites.md)、背景は[設計案](../../docs/design/external-execution.md)）で、計算機（site）ごとに書く`job.sh`と、launcherの設定の例です。管理者はこれを写してサイトrepo（管理者だけが変更できるgit repo）に置き、サイトに合わせて書き換えます。launcher（OTPのサイトでは本人の`mado-tracking submit`）は、投入のたびにサイトのログインノード（直実行ならそのホスト）で`job.sh`を実行します。

`examples/`の値（キュー名、資源タイプ、グループの指定、hostname、path）はすべて例です。実際のサイトの資料で確かめてから使ってください。

| ファイル | 内容 |
|---|---|
| [examples/launcher.toml](examples/launcher.toml) | launcher自身の設定（`launcher_id`、`state_directory`、Projectごとの`api_url`と`token_file`） |
| `examples/<方式>/site.toml` | `launcher.toml`へ足す`[[sites]]`の1つ分 |
| `examples/<方式>/job.sh` | そのサイトのjob shell |
| `examples/<方式>/README.md` | そのサイトで書き換えるところ |

## 例の一覧

| ディレクトリ | 投入先 | arrayの指定 | 計算ノードでの番号 | 標準出力に出すID | 取消 |
|---|---|---|---|---|---|
| [pbs](examples/pbs/) | PBS Professional（ABCI 3.0の書き方） | `-J 0-(N-1)` | `PBS_ARRAY_INDEX` | `qsub`の出力（`12345.server`、arrayは`12345[].server`） | `qdel` |
| [slurm](examples/slurm/) | Slurm | `--array=0-(N-1)` | `SLURM_ARRAY_TASK_ID` | `sbatch --parsable`の出力（`;cluster`は外す） | `scancel` |
| [grid-engine](examples/grid-engine/) | Grid Engine（TSUBAME4.0の書き方） | `-t 1-N` | `SGE_TASK_ID`から1を引く | `qsub -terse`の出力（arrayは`.1-N:1`を外す） | `qdel` |
| [fujitsu-tcs](examples/fujitsu-tcs/) | Fujitsu TCS（富岳の書き方） | `--bulk --sparam 0-(N-1)` | `PJM_BULKNUM` | `pjsub`の`[INFO] ... Job <ID> submitted.`から取り出す | `pjdel` |
| [direct-docker](examples/direct-docker/) | スケジューラのないGPUホスト（Docker） | runnerをN個起動する | job shellが0から振る | 何も出さない | runnerがheartbeatで気づいて止める |
| [direct-apptainer](examples/direct-apptainer/) | スケジューラのないGPUホスト（Apptainer） | 同上 | 同上 | 何も出さない | 同上 |

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
| `MMT_VAR_<名前>` | 個人設定（と、サイト共通）の変数。例: `MMT_VAR_GROUP` |

- launcherは`job.sh`を、内容のhashごとに`<work_dir>/.mmt-job-shells/<hash>/job.sh`へ置き、仕様の置き場をcurrent directoryにして実行します。値は`env NAME=value`で1つずつ渡り、シェルを通りません。
- 標準出力の最後の行に、スケジューラのジョブIDだけを出します。直実行のホストでは何も出しません。例のjob shellは、標準出力にIDの1行だけを出し、ほかの表示はすべて標準エラーへ出します。標準エラーの終わりの部分は、失敗の理由としてJobに残ります。
- 終了コードが0でなければ、投入の失敗（`submit_failed`）として報告されます。依頼の値が検証に通らないときも、投入せずに失敗します。
- arrayは`MMT_ARRAY_SIZE`が2以上のときだけ使います。計算ノード側で、スケジューラの番号を0始まりの`MMT_ARRAY_INDEX`に直してから`exec "$MMT_RUNNER" "$MMT_SPEC_DIR"`します（1つのJobなら0）。
- 取消コマンド（`cancel_command`）は、job shellが出したIDを`MMT_SCHEDULER_JOB_ID`で受け取ります。arrayのIDを渡すと、全員が待ち行列から外れます。
- job shellは`sh job.sh`でも、ファイルとして直接でも、標準入力から（`sh -s`）でも動きます。スケジューラのコマンドには標準入力を渡しません。

## 安全のための決まり

- 依頼の値は環境変数だけで受け取り、スクリプトの文字列に埋め込みません（`eval`もしません）。job shellが書き出すbatch script（`$MMT_SPEC_DIR/batch.sh`、直実行は`run.sh`）は定数の文字列で、計算ノードで環境変数から値を読みます。
- 値はスケジューラへ渡す前に検証します。数は符号と先頭の0のない10進数、pathは英数字と`._/+@-`だけ、グループ名などは英数字と`._-`だけです。オプションの値は別々の引数として渡し、シェルを通しません。
- tokenなどの秘密は仕様の置き場のファイル（600）にだけあります。引数、スケジューラのオプション（`qsub -v`など）、環境変数には載りません。そのため、ジョブへ環境変数を渡しても秘密は渡りません。PBSとGrid Engineの例は`-v`で渡す名前をpathと数に限り、SlurmとTCSの例は投入時の環境をそのまま渡します（`--export=ALL`、`-X`）。
- job shellはコンテナの外で、投入したアカウントの権限で動きます。サイトrepoは管理者だけが変更できるようにします。共用アカウントのホストでは、job shellが他の人のJobの秘密ファイルも読めるためです（利用者どうしは隔離しません）。
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

- 計算機の`queueTimeoutSeconds`を設定すると、上限を過ぎたJobは失敗（`queue_timeout`）になります。
- 原因は`$MMT_SPEC_DIR/scheduler.*.log`（直実行は`runner.<番号>.log`）に残ります。仕様の置き場は`<work_dir>/.mmt-submissions/<最初のJob ID>`です。
- 例のbatch scriptは、runnerを起動する前の処理を最小限にしています。書き換えるときも、runnerの前に失敗しうる処理を増やさないでください。runnerの実行ファイルが無いときは、ログインノードのjob shellが投入の前に失敗にします。

## launcherの設定（launcher.toml）

launcherは1つのTOMLを読みます（`mado-tracking-launcher --config <path>`か`MMT_LAUNCHER_CONFIG`）。[examples/launcher.toml](examples/launcher.toml)の後ろに、使うサイトの`site.toml`の中身（`[[sites]]`の表）を並べます。相対pathは`launcher.toml`のディレクトリから数えるので、例では`job_shell = "pbs/job.sh"`のように書いています。読み方の正本は`python/src/mado_tracking/site/launcher_config.py`と`site_settings.py`です。

| 場所 | 項目 | 内容 |
|---|---|---|
| 最上位 | `launcher_id`、`state_directory`、`poll_seconds` | 再起動しても変えない名前、投入中の記録と未送信の報告の置き場、取得の間隔（秒） |
| `[[projects]]` | `name`、`api_url`、`token_file` | 投入するProjectごとに1つ。launcherから見たAPIのURLと、project worker token（Service Accountの`read`と`worker:execute`）のファイル（mode 600） |
| `[[sites]]` | `target_id`、`account_mode`、`job_shell`、`work_dir`、`runner_python`、`runner_api_url`、`cancel_command`、`max_active_submissions` | 計算機のID、`shared`か`personal`、job shell、計算ノードからも見える作業ディレクトリ、runnerのPython（3.11以上）、計算ノードから見たAPIのURL、取消コマンド、1回の取得で受け取るsubmissionの上限（1〜50） |
| `[[sites]]` | `variables` | サイト共通の`MMT_VAR_<名前>` |
| `[[sites]]` | `gpu_assignment`、`gpu_ids` | `scheduler`（既定）か、スケジューラのないホストの`lease`。`lease`ではrunnerが`gpu_ids`（空なら全部）から空いたGPUを選びます |
| `[[sites]]` | `registry_secret_file` | 任意。imageの取得に使う読み取り専用tokenのJSON（`{"username", "password"}`、mode 600） |
| `[[sites]]` | `cancel_grace_seconds`、`max_output_files` | 任意。コンテナを止めるときの猶予、1つのJobが保存できる出力の数 |
| `[sites.connection]` | `host`、`port`、`user`、`identity_file`、`known_hosts`、`jump_hosts` | SSHの接続先。`user`と`identity_file`は共用アカウントのもの。launcherがサイトの上で動くときは`local = true` |
| `[sites.accounts."<email>"]` | `user`、`identity_file`、`work_dir`、`variables` | `personal`のサイトで、依頼者のemailごとのアカウント、鍵、作業ディレクトリ、個人の`MMT_VAR_*`（例: `GROUP`） |

- 鍵・known_hosts・tokenのファイルは、launcherの実行ユーザーが所有し、groupとotherが読めないようにします（そうでなければlauncherとsshが拒みます）。known_hostsは事前に確かめたものを置きます。
- 依頼者のemailに対応するアカウントが無い`personal`のサイトでは、その依頼は投入されずに失敗します。

## OTPのあるサイト（`mado-tracking submit`）

計算機の`submissionMode`が`manual`のサイトには、launcherは投入しません。本人がOTPでログインノードに入り、自分のAPI token（`MMT_API_URL`、`MMT_API_TOKEN`）で`mado-tracking submit --site <計算機のID>`を実行します。同じ`job.sh`を使い、サイトの値は`~/.config/mado-tracking/submit.toml`（または`MMT_SUBMIT_CONFIG`）に書きます。

```toml
[sites."00000000-0000-4000-8000-000000000007"]
job_shell = "~/mmt/job.sh"
work_dir = "/work/gxx00000/alice/mmt"
runner_python = "/work/gxx00000/alice/mmt/python/bin/python3"
runner_api_url = "https://mmt-runner.example.org"
variables = { GROUP = "gxx00000" }
```

`--var GROUP=...`のように、command lineでも変数を渡せます。

## サイトで試す

ダミーの仕様置き場と、受け取った値を表示するだけのrunnerで、job shellを手で動かします。`<work_dir>`はサイトの`work_dir`です。

```sh
mkdir -m 700 <work_dir>/try-spec
printf '#!/bin/sh\necho "index=$MMT_ARRAY_INDEX spec=$1"\n' > <work_dir>/try-runner
chmod 700 <work_dir>/try-runner
env MMT_SPEC_DIR=<work_dir>/try-spec MMT_RUNNER=<work_dir>/try-runner \
  MMT_GPU_COUNT=0 MMT_ARRAY_SIZE=2 MMT_WALLTIME=00:05:00 MMT_WALLTIME_SECONDS=300 \
  MMT_JOB_IDS=00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002 \
  MMT_VAR_GROUP=<グループ> sh job.sh
```

最後の行がジョブIDだけで、ジョブが終わった後に`<work_dir>/try-spec/scheduler.*.log`へ`index=0 ...`と`index=1 ...`が出れば、約束どおりです。取消は`MMT_SCHEDULER_JOB_ID=<ID> sh -c '<cancel_commandの値>'`で確かめます。

## launcherをDocker composeで動かす

`compose.yml`の`launcher`（profile `launcher`、[Dockerfile.launcher](../../Dockerfile.launcher)）です。

```bash
docker compose --profile launcher build launcher
docker compose --profile launcher up -d launcher
docker compose --profile launcher logs -f launcher
```

| 設定 | 既定 | containerの中 | 内容 |
|---|---|---|---|
| `MMT_LAUNCHER_CONFIG_DIR` | `./var/launcher-config` | `/etc/mado-tracking-launcher`（read-only） | サイトrepoのcheckout。最上位に`launcher.toml`を置きます |
| `MMT_LAUNCHER_SECRETS_DIR` | `./var/launcher-secrets` | `/run/secrets/mado-tracking-launcher`（read-only） | `token_file`と`registry_secret_file`のファイル |
| `MMT_LAUNCHER_SSH_DIR` | `./var/launcher-ssh` | `/home/launcher/.ssh`（read-only） | `identity_file`と`known_hosts`のファイル |
| `MMT_LAUNCHER_UID`、`MMT_LAUNCHER_GID` | `10002` | — | 上のファイルの所有者に合わせてbuildします |
| volume `launcher-state` | — | `/var/lib/mado-tracking-launcher` | `launcher.toml`の`state_directory`にします。消すと、投入中の記録と未送信の報告を失います |

- composeの中から同じホストのAPIを使うときは、`api_url = "http://api:4182"`です。runnerに渡すURLは、サイトごとの`runner_api_url`です。
- 動かす前に`docker compose --profile launcher run --rm launcher --once`で、1回だけ取得と投入を試せます。
