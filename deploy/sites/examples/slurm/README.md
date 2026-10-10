# Slurm

共用アカウントで使うSlurmクラスタの例です。partition名・CPU数・accountの指定は例なので、サイトの設定で確かめて書き換えてください。共通の約束は[../../README.md](../../README.md)にあります。

## 書き換えるところ

| 場所 | 例の値 | 内容 |
|---|---|---|
| `job.sh`の`PARTITION` | `gpu` | 投入するpartition |
| `job.sh`の`CPUS_PER_TASK` | `8` | 1つのJobに割り当てるCPU数 |
| `job.sh`の`MAX_GPUS_PER_NODE` | `8` | 1ノードのGPU数。1つのJobは1ノードで動くので、これを超える依頼は投入せずに失敗にします |
| `job.sh`の`DEFAULT_WALLTIME_SECONDS` | `3600` | 制限時間を指定しないJobの制限時間。partitionの`MaxTime`以下にします |
| `job.sh`の`TIMEOUT_NOTICE_SECONDS` | `120` | 制限時間の何秒前にrunnerへSIGTERMを送らせるか（`--signal=B:TERM@120`） |
| batch script（`job.sh`の`BATCH`の中） | コメント | `module load apptainer`など、計算ノードがproxy経由でしか外へ出られないときの`https_proxy` |

GPUは`--gres=gpu:N`で要求します。GPUの種類を指定するサイトでは`--gres=gpu:<種類>:N`、`--gpus`を使うサイトではその形に変えます。

## Webに入れる値

雛形「Slurm」を選ぶと、job shell、取消コマンド（`scancel "$MMT_SCHEDULER_JOB_ID"`）、array、GPUの渡し方（スケジューラ）、runtime（`apptainer`）が入ります。そのほかは次の例のように入れます。利用者がすることはありません（共用アカウントの計算機には「自分の設定」がありません）。

| 全体設定 | 例の値 | 内容 |
|---|---|---|
| 投入方式 | 自動 | launcherがSSHで入って投入します |
| 接続先 | host `slurm-login.example.internal`、port 22 | known_hostsにはログインノードの行を入れます |
| ログインするアカウント | 共用のアカウント、`mmt-launcher` | 計算機の詳細に出る公開鍵を、このアカウントの`~/.ssh/authorized_keys`に登録します |
| 作業ディレクトリ | `/shared/mmt` | ログインノードと計算ノードから同じパスで見える場所 |
| runnerのPython | `/shared/mmt/python/bin/python3` | 計算ノードのPython 3.11以上 |
| runnerから見たAPIのURL | `https://tracking.example.internal` | LANの中のクラスタなら、trackingのhostnameそのものを使えます |
| 変数 | `ACCOUNT=lab-a` | 任意。共用アカウントのSlurmのaccount（`MMT_VAR_ACCOUNT`）。あれば`--account`に渡します |
| 1回に受け取る数 | `50` | launcherが1回の巡回で受け取るsubmissionの上限（arrayは1つと数えます） |

## 動き

- arrayは`--array=0-(N-1)`で投入し、計算ノードでは`SLURM_ARRAY_TASK_ID`をそのまま`MMT_ARRAY_INDEX`にします。arrayの大きさはクラスタの`MaxArraySize`（既定1001、つまり番号1000まで）を超えられません。
- `sbatch --parsable`は`<ID>`か`<ID>;<cluster>`を出すので、`;`の後ろを外してIDだけを出します。`scancel <ID>`でarrayの全員が外れます。
- `--export=ALL`で、投入時の環境（`MMT_SPEC_DIR`など）がジョブへ渡ります。秘密は環境変数に載らないので、ジョブの属性にも残りません。
- Slurmの予告の時刻は最大60秒ほど前後します。
- batch scriptの出力は`$MMT_SPEC_DIR/scheduler.<ID>.log`（arrayは`scheduler.<ID>_<番号>.log`）です。
