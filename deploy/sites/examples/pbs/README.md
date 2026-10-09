# PBS Professional

ABCI 3.0の書き方に合わせた例です。キュー名・資源タイプ・グループの指定は例なので、サイトの資料で確かめて書き換えてください。共通の約束は[../../README.md](../../README.md)にあります。

## 書き換えるところ

| 場所 | 例の値 | 内容 |
|---|---|---|
| `job.sh`の`DEFAULT_WALLTIME_SECONDS` | `3600` | 制限時間を指定しないJobの制限時間。キューの上限以下にします |
| `job.sh`の`MAX_GPUS_PER_NODE` | `8` | 1ノードのGPU数。1つのJobは1ノードで動くので、これを超える依頼は投入せずに失敗にします |
| `job.sh`の`resource_type_for_gpus` | `rt_HC`・`rt_HG`・`rt_HF` | GPU数から資源タイプ（`-q`）を選ぶ対応。ABCIでは2〜8 GPUの依頼はノード全体（`rt_HF`、8 GPU）になります |
| batch script（`job.sh`の`BATCH`の中） | コメント | `source /etc/profile.d/modules.sh`と`module load`（runnerが使うSingularity/Apptainer）、計算ノードがproxy経由でしか外へ出られないときの`https_proxy` |
| `site.toml`の`[sites.accounts."<email>"]`の`variables`の`GROUP` | `gaa50000` | 本人のABCIのグループ（`MMT_VAR_GROUP`、`-P`、必須）。無い依頼は投入せずに失敗にします |
| `site.toml` | — | `target_id`、`[sites.connection]`、利用者ごとの`[sites.accounts."<email>"]`、`work_dir`、`runner_python`、`runner_api_url`、`max_active_submissions` |

## 資源タイプの無いPBSでは

`-q "$resource_type"`をキュー名（例: `-q gpu`）に変え、`-l select=1`を`-l "select=1:ngpus=$MMT_GPU_COUNT"`にします（GPUが0なら`select=1`のまま）。`resource_type_for_gpus`は要らなくなります。

## 動き

- arrayは`-J 0-(N-1)`で投入し、計算ノードでは`PBS_ARRAY_INDEX`をそのまま`MMT_ARRAY_INDEX`にします。`MMT_ARRAY_SIZE`が1のときは`-J`を付けません。
- `qsub`はIDだけを出します（`12345.server`、arrayは`12345[].server`）。`qdel "12345[].server"`でarrayの全員が外れます。
- 制限時間ではSIGTERMが届き、キューの`kill_delay`の後にSIGKILLになります。runnerがコンテナを止めて報告するまでの時間が足りないときは、サイトの`kill_delay`を確かめてください。
- batch scriptの出力は`$MMT_SPEC_DIR/scheduler.log`（arrayは`scheduler.<番号>.log`）です。
