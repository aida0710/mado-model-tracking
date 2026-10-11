# PBS Professional

ABCI 3.0の書き方に合わせた例です。キュー名・資源タイプ・グループの指定は例なので、サイトの資料で確かめて書き換えてください。共通の約束は[../../README.md](../../README.md)にあります。

## 書き換えるところ

| 場所 | 例の値 | 内容 |
|---|---|---|
| `job.sh`の`DEFAULT_WALLTIME_SECONDS` | `3600` | 制限時間を指定しないJobの制限時間。キューの上限以下にします |
| `job.sh`の`MAX_GPUS_PER_NODE` | `8` | 1ノードのGPU数。1つのJobは1ノードで動くので、これを超える依頼は投入せずに失敗にします |
| `job.sh`の`resource_type_for_gpus` | `rt_HC`・`rt_HG`・`rt_HF` | GPU数から資源タイプ（`-q`）を選ぶ対応。ABCIでは2〜8 GPUの依頼はノード全体（`rt_HF`、8 GPU）になります |
| batch script（`job.sh`の`BATCH`の中） | コメント | `source /etc/profile.d/modules.sh`と`module load`（runnerが使うSingularity/Apptainer）、計算ノードがproxy経由でしか外へ出られないときの`https_proxy` |

## Webに入れる値

雛形「PBS Professional」を選ぶと、job shell、取消コマンド（`qdel "$MMT_SCHEDULER_JOB_ID"`）、array、GPUの渡し方（スケジューラ）、runtime（`singularity`）が入ります。そのほかは次の例のように入れます。

| 全体設定 | 例の値 | 内容 |
|---|---|---|
| 投入方式 | 自動 | launcherがSSHで入って投入します。ログインにOTPが要るPBSのsiteでは手動にします（下の「OTPのあるsiteでは」） |
| 接続先 | host `login.hpc.example.org`、port 22、経由するホスト`gateway.hpc.example.org` | known_hostsには、接続先と経由するホストの両方の行を入れます |
| ログインするアカウント | 本人のアカウント | 各利用者が、自分のアカウントで投入します |
| 作業ディレクトリ | `/groups/gaa00000/mmt` | ログインノードと計算ノードから同じパスで見える場所。各利用者が自分の設定で置き換えられます |
| runnerのPython | `/groups/gaa00000/mmt/python/bin/python3` | 計算ノードのPython 3.11以上 |
| runnerから見たAPIのURL | `https://mmt-runner.example.org` | runner用の公開hostname（[deploy/edge](../../../edge/README.md)） |
| 1回に受け取る数 | `20` | launcherが1回の巡回で受け取るsubmissionの上限（arrayは1つと数えます） |

| 自分の設定（各利用者） | 例の値 | 内容 |
|---|---|---|
| アカウント名 | `acb12345` | 本人のABCIのアカウント。保存するとlauncherが鍵を作るので、出た公開鍵をサイトの方法（利用者ポータルなど）で登録します |
| 変数 | `GROUP=gaa50000` | 本人のABCIのグループ（`MMT_VAR_GROUP`、`-P`、必須）。無い依頼は投入せずに失敗にします |

## OTPのあるsiteでは

投入方式を手動にします（アカウントは、投入する本人のものになります）。接続先は要りません。各利用者は自分の設定に`GROUP`などの変数（と必要なら作業ディレクトリ）を入れ、ログインノードで`mado-tracking submit --site <コンピュータのID>`を実行します（[../../README.md](../../README.md)の「手動投入のコンピュータ」）。

## 資源タイプの無いPBSでは

`-q "$resource_type"`をキュー名（例: `-q gpu`）に変え、`-l select=1`を`-l "select=1:ngpus=$MMT_GPU_COUNT"`にします（GPUが0なら`select=1`のまま）。`resource_type_for_gpus`は要らなくなります。

## 動き

- arrayは`-J 0-(N-1)`で投入し、計算ノードでは`PBS_ARRAY_INDEX`をそのまま`MMT_ARRAY_INDEX`にします。`MMT_ARRAY_SIZE`が1のときは`-J`を付けません。
- `qsub`はIDだけを出します（`12345.server`、arrayは`12345[].server`）。`qdel "12345[].server"`でarrayの全員が外れます。
- 制限時間ではSIGTERMが届き、キューの`kill_delay`の後にSIGKILLになります。runnerがコンテナを止めて報告するまでの時間が足りないときは、サイトの`kill_delay`を確かめてください。
- batch scriptの出力は`$MMT_SPEC_DIR/scheduler.log`（arrayは`scheduler.<番号>.log`）です。
