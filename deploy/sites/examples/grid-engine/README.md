# Grid Engine

TSUBAME4.0（Altair Grid Engine）の書き方に合わせた例です。資源タイプ・グループの指定は例なので、サイトの資料で確かめて書き換えてください。共通の約束は[../../README.md](../../README.md)にあります。

## 書き換えるところ

| 場所 | 例の値 | 内容 |
|---|---|---|
| `job.sh`の`DEFAULT_WALLTIME_SECONDS` | `3600` | 制限時間を指定しないJobの制限時間。TSUBAMEでは`h_rt`が必須で、通常の上限は24時間です |
| `job.sh`の`resource_type_for_gpus` | `cpu_8`・`gpu_1`・`node_h`・`node_f` | GPU数から資源タイプ（`-l <type>=1`）を選ぶ対応。1ノードのGPU（TSUBAMEは4）を超える依頼は、投入せずに失敗にします |
| batch script（`job.sh`の`BATCH`の中）の`TIMEOUT_NOTICE_SECONDS` | `120` | 制限時間の何秒前にrunnerへSIGTERMを送るか |
| batch script（`job.sh`の`BATCH`の中） | コメント | `module load apptainer`など、計算ノードがproxy経由でしか外へ出られないときの`https_proxy` |
| `site.toml`の`[sites.accounts."<email>"]`の`variables`の`GROUP` | `tga-example` | 本人のTSUBAMEのグループ（`MMT_VAR_GROUP`、`-g`、必須）。無い依頼は投入せずに失敗にします |
| `site.toml` | — | `target_id`、`[sites.connection]`、利用者ごとの`[sites.accounts."<email>"]`、`work_dir`、`runner_python`、`runner_api_url`、`max_active_submissions` |

## 一般的なGrid Engineでは

- `-g`はTSUBAMEの`qsub`の指定です。ほかのサイトではprojectの`-P`やaccountの`-A`に変えます。
- GPUを消費可能な資源（complex）`gpu`で数えるサイトでは、`-l "$resource_type=1"`を`-l "gpu=$MMT_GPU_COUNT"`にし、並列環境（`-pe`）でCPU数を指定します。

## 動き

- arrayは`-t 1-N`で投入します。Grid Engineのtask番号は1から始まるので、計算ノードで`SGE_TASK_ID`から1を引いて`MMT_ARRAY_INDEX`にします。arrayでないジョブでは`SGE_TASK_ID`が`undefined`なので、番号を見ずに0にします。
- `qsub -terse`は`<ID>`、arrayでは`<ID>.1-N:1`を出すので、`.`の後ろを外してIDだけを出します。`qdel <ID>`でarrayの全員が外れます。
- `h_rt`に達すると予告なしにSIGKILLになります。そのためbatch scriptはrunnerを子プロセスとして起動し、制限時間の`TIMEOUT_NOTICE_SECONDS`前にSIGTERMを送ります。batch scriptが受けたSIGTERMもrunnerへ渡します。runnerが終われば、timerも止めて終わります。
- `-S /bin/bash`でbatch scriptをbashで動かします（Grid Engineは既定で`#!`の行を見ないため）。
- batch scriptの出力は`$MMT_SPEC_DIR/scheduler.<番号>.log`（arrayでないジョブは`scheduler.undefined.log`）です。
