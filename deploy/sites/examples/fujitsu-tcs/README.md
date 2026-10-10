# Fujitsu Technical Computing Suite（pjsub）

富岳の書き方に合わせた例です。資源グループ・グループの指定は例なので、サイトの資料で確かめて書き換えてください。共通の約束は[../../README.md](../../README.md)にあります。

## 書き換えるところ

| 場所 | 例の値 | 内容 |
|---|---|---|
| `job.sh`の`RESOURCE_GROUP` | `small` | 資源グループ（`-L rscgrp=`） |
| `job.sh`の`DEFAULT_WALLTIME_SECONDS` | `3600` | 制限時間を指定しないJobの制限時間（`-L elapse=`）。資源グループの上限以下にします |
| `job.sh`の`MAX_GPUS_PER_NODE` | `0` | 富岳のノードにはGPUがないので、GPUを要求する依頼は投入せずに失敗にします |
| `job.sh`の`-x PJM_LLIO_GFSCACHE`（コメント） | `/vol0004` | 富岳では、ジョブが読むデータ領域を指定します |
| batch script（`job.sh`の`BATCH`の中）の`TIMEOUT_NOTICE_SECONDS` | `120` | 制限時間の何秒前にrunnerへSIGTERMを送るか |
| batch script（`job.sh`の`BATCH`の中） | コメント | Singularity/Apptainerを使えるようにする手順、計算ノードがproxy経由でしか外へ出られないときの`https_proxy` |

GPUのあるTCSのサイトでは、`MAX_GPUS_PER_NODE`をノードのGPU数にし、そのサイトのGPUの指定（`-L`の項目など）を`set -- "$@" ...`で足します。

## Webに入れる値

雛形「Fujitsu TCS」を選ぶと、job shell、取消コマンド（`pjdel "$MMT_SCHEDULER_JOB_ID"`）、array（バルクジョブ）、GPUの渡し方（スケジューラ）、runtime（`singularity`）が入ります。そのほかは次の例のように入れます。

| 全体設定 | 例の値 | 内容 |
|---|---|---|
| CPU | `arm64` | 富岳のCPU（A64FX） |
| 投入方式 | 自動 | launcherがSSHで入って投入します |
| 接続先 | host `login.hpc.example.org`、port 22 | known_hostsにはログインノードの行を入れます |
| ログインするアカウント | 本人のアカウント | 各利用者が、自分のアカウントで投入します |
| 作業ディレクトリ | `/vol0004/hp000000/mmt` | ログインノードと計算ノードから同じパスで見える場所。各利用者が自分の設定で置き換えられます |
| runnerのPython | `/vol0004/hp000000/mmt/python/bin/python3` | 計算ノードの、arm64のPython 3.11以上 |
| runnerから見たAPIのURL | `https://mmt-runner.example.org` | runner用の公開hostname（[deploy/edge](../../../edge/README.md)） |
| 1回に受け取る数 | `10` | launcherが1回の巡回で受け取るsubmissionの上限（バルクジョブは1つと数えます） |

| 自分の設定（各利用者） | 例の値 | 内容 |
|---|---|---|
| アカウント名 | `u00000` | 本人の富岳のアカウント。保存するとlauncherが鍵を作るので、出た公開鍵をサイトの方法（利用者ポータルなど）で登録します |
| 変数 | `GROUP=hp000000` | 本人の課金のグループ（`MMT_VAR_GROUP`、`-g`、必須）。無い依頼は投入せずに失敗にします |

## 動き

- arrayはバルクジョブ（`--bulk --sparam 0-(N-1)`）で投入し、計算ノードでは`PJM_BULKNUM`をそのまま`MMT_ARRAY_INDEX`にします。1つのバルクジョブのサブジョブは65535個までで、サイトの権限設定でさらに制限されることがあります。
- `pjsub`は`[INFO] PJM 0000 pjsub Job 12345 submitted.`を出すので、IDだけを取り出します。バルクジョブも同じ形で、`pjdel 12345`で全サブジョブが外れます。
- `-X`で、投入時の環境（`MMT_SPEC_DIR`など）がジョブへ渡ります。秘密は環境変数に載りません。`LD_LIBRARY_PATH`など一部の変数は`-X`でも渡らないので、要るものはbatch scriptで設定します。
- `elapse`に達すると、ジョブの全プロセスにSIGXCPUが届き、10秒後にSIGKILLになります。batch scriptはrunnerをSIGXCPUを無視する状態で起動し、SIGXCPU（とSIGTERM）を受けたらrunnerへSIGTERMを送ります。制限時間の`TIMEOUT_NOTICE_SECONDS`前にも送ります。
- 富岳のCPUはArm（A64FX）です。計算機のCPUを`arm64`にし、arm64を含むimageと、arm64のPython（runnerのPython）を使います。
- batch scriptの出力は`$MMT_SPEC_DIR/scheduler.<サブジョブID>.log`です。
