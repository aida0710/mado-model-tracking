---
title: Python SDKで記録する
description: mado-trackingのインストール、start_run、log_metrics、システムメトリクス、Runの再開、オフライン記録とsync。
---

# Python SDKで記録する

![SDKで記録した学習RunのMetricsタブ](/images/tracking-run-metrics.png)

`mado-tracking`は、学習コードからRunを記録するPython SDKです。params・metrics・Artifactの記録に加え、GPUやメモリの使用量（システムメトリクス）、終わったRunへの追記、APIに届かないマシンでのオフライン記録に対応しています。

公式のMLflow 3 SDKから記録することもできます（[MLflow 3から記録する](/tracking/mlflow)）。既存のMLflowのコードをそのまま使うならMLflow、システムメトリクスやオフライン記録、stepごとの音声を使うならこのSDKが向いています。

## こんなときに向いています

- 学習のたびに、lossとGPU使用率を同じ画面で確かめたい
- 途中で止めた学習を、同じRunに続きのstepから記録したい
- 社内ネットワークに直接つながらない計算機で学習し、結果を後から送りたい

## インストールする {#install}

Python 3.11以上が必要です。学習を実行するマシンのターミナルで、仮想環境を作ってインストールします。

Linux・macOS:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install \
  'mado-tracking[telemetry] @ git+https://github.com/aida0710/mado-ml-tracking.git#subdirectory=python'
```

Windows（PowerShell）:

```powershell
py -3 -m venv .venv
.venv\Scripts\python -m pip install `
  "mado-tracking[telemetry] @ git+https://github.com/aida0710/mado-ml-tracking.git#subdirectory=python"
```

`[telemetry]`はシステムメトリクス用の`psutil`と`nvidia-ml-py`を入れます。numpyの配列やPILの画像を音声・画像として記録する場合は`[telemetry,media]`にします。

インストールできたかは、次のコマンドで確かめます。`usage: mado-tracking`から始まるヘルプが出れば完了です。

```bash
.venv/bin/mado-tracking --help
```

## 接続先とtokenを設定する

SDKは環境変数から接続先とAPI tokenを読みます。tokenは［プロジェクト設定］の「MLflow 3から接続」にある［このProject用のAPI tokenを発行］から作れます。記録には`read`と`runs:write`、Artifactを送るなら`artifacts:write`のscopeが必要です。このボタンはこれらを選んだ状態で発行画面を開きます（[API token](/admin/tokens)）。

| 環境変数 | 入力する値 | 例 |
| --- | --- | --- |
| `MMT_API_URL` | WebのURL（`/api`まででもよい） | `https://tracking.example.internal` |
| `MMT_API_TOKEN` | API token | 画面で発行した値 |
| `MMT_PROJECT_ID` | 記録先ProjectのID | `/projects/<ID>/...`のURLに含まれるUUID |
| `MMT_EXPERIMENT_ID` | 記録先ExperimentのID | Experimentの画面の見出しの下に出る`ID` |

tokenは画面に表示しない形で入力し、ソースコードやGitで管理するファイルには書かないでください。

```bash
export MMT_API_URL='https://tracking.example.internal'
export MMT_PROJECT_ID='PROJECT_ID'
export MMT_EXPERIMENT_ID='EXPERIMENT_ID'
read -r -s -p 'API token: ' MMT_API_TOKEN
export MMT_API_TOKEN
```

## Runを記録する

```python
import mado_tracking

with mado_tracking.start_run(name="lr-0.05", parameters={"learning_rate": 0.05, "epochs": 3}) as run:
    run.set_tags({"dataset": "training-v1"})
    for step in range(100):
        loss = train_one_step()
        run.log_metrics({"train.loss": loss}, step=step)
    run.log_artifact("model.bin")
```

- `start_run`は`MMT_PROJECT_ID`と`MMT_EXPERIMENT_ID`を使います。引数の`project_id=`・`experiment_id=`で指定することもできます
- `kind=`で実行種別（`training`・`finetuning`・`inference`・`evaluation`・`processing`）を指定します。省略すると`training`です
- `with`を抜けるとRunは完了になります。途中で例外が起きた場合は、エラーをLogsに残して失敗になります
- metricsの値はNaNや無限大を受け付けません。新しいRunで`step`を省略すると0で記録します
- `log_artifact`は64MiB以上のファイルを分割して送り、途中で切れても呼び直せば続きから送ります。ディレクトリをまとめて送るときは`log_artifacts`を使います

記録したRunは、画面の［Experiments］で対象のExperimentを開くと一覧に出ます。

Workerで動くJobの中では、`start_run`は新しいRunを作らず、Jobに割り当てられたRunに記録します。

## システムメトリクスを記録する {#system-metrics}

![System metricsタブ。CPU、メモリ、ディスクの図が並ぶ](/images/tracking-system-metrics.png)

`system_metrics=True`を付けると、CPU・メモリ・ディスク・ネットワーク・GPUの使用量を一定間隔で記録します。

```python
with mado_tracking.start_run(name="lr-0.05", system_metrics=True, system_metrics_interval=15) as run:
    ...
```

- 間隔の既定は15秒、最短は1秒です
- 名前は`system.cpu.percent`、`system.memory.used_bytes`、`system.gpu.0.utilization_percent`のように`system.`で始まります。Runの［System metrics］タブに種類ごとの図で表示します
- GPUは`CUDA_VISIBLE_DEVICES`で見えているものだけを記録します。`psutil`やNVIDIAのドライバが無い項目は記録しません
- 環境変数`MMT_SYSTEM_METRICS=false`を設定すると、コードの指定があっても記録しません
- WorkerのJobの中では、Workerが同じ項目を記録するので起動しません

既定では記録しません。W&Bは既定で記録し、MLflowは既定で記録しない点が違います。

## 終わったRunに続きを記録する {#resume}

止めた学習を同じRunで続けるときは、`run_id`と`resume`を指定します。

```python
run = mado_tracking.start_run(run_id="RUN_ID", resume="must")
run.log_metrics({"train.loss": 0.12})   # 前回の最大step+1で記録される
run.finish()
```

| `resume` | 動作 |
| --- | --- |
| `"never"`（既定） | 常に新しいRunを作ります。`run_id`だけを渡すとエラーです |
| `"must"` | 既存のRunを開き直します。Runが無ければエラーです |
| `"allow"` | Runがあれば開き直し、無ければそのIDで新しく作ります（`experiment_id`と`name`が必要） |

- 再開したRunで`step`を省略すると、キーごとに前回の最大step+1から続けます。いまの最大stepは`run.last_step("train.loss")`で読めます
- 再開するたびに記録が残り、Runの図に「再開」の印が付きます。Runの詳細には実行区間（最初の実行、再開1、再開2…）が表示されます
- WorkerのJobで動いたRunは再開できません。途中から続けるには、checkpointから新しいRunとして再実行します（[学習の途中再開](/models/checkpoints)）
- システムメトリクスのstepは再開のたびに0から数えるので、前の区間と重なります

## オフラインで記録して後から送る

APIに届かないマシンでは、ローカルに記録しておき、つながるマシンから送ります。

```python
with mado_tracking.start_run(
    project_id="PROJECT_ID", experiment_id="EXPERIMENT_ID", name="offline-run",
    mode="offline", system_metrics=True,
) as run:
    run.log_metrics({"train.loss": 0.5}, step=1)
    run.log_artifact("model.bin")
```

`mode`の代わりに環境変数`MMT_MODE`でも指定できます。

| モード | 動作 |
| --- | --- |
| `online`（既定） | APIへ直接記録します |
| `offline` | APIに一度も接続せず、ローカルに記録します。`MMT_API_URL`と`MMT_API_TOKEN`は不要です |
| `auto` | APIへ記録し、接続できなくなったらそのRunだけローカルの記録に切り替えます |

記録は`MMT_OFFLINE_DIR`（既定は`~/.local/share/mado-tracking/offline`）にRunごとのフォルダで保存します。tokenは書き込みません。Artifactは既定でフォルダの中に複製するので、フォルダごと別のマシンへ移しても送れます。

APIに届くマシンで、接続先とtokenを設定してから`sync`を実行します。tokenには`runs:write`と`artifacts:write`が必要です。

```bash
mado-tracking sync --dry-run          # 送る予定の件数だけ表示（APIに接続しない）
mado-tracking sync                    # MMT_OFFLINE_DIRの全Runを送る
mado-tracking sync /path/to/offline   # 指定したフォルダのRunを送る
mado-tracking sync --project-id PROJECT_ID --prune   # 指定したProjectの分だけ送り、送り終えた記録を消す
```

- 途中で失敗しても、もう一度実行すれば続きから送ります。同じ記録を2回送っても、Runやmetricsは増えません
- 記録中のRunは飛ばします。終了していないRunは送りますが、実行中のまま残します
- 送れなかったRunがあると、終了コードは1になります

オフラインでは、モデル・データセットの登録、checkpoint、Runの再開は使えません。

## 関連する機能

- stepごとの音声・画像・表: [メディアの記録と聴き比べ](/tracking/media)
- Sweepの試行で条件を読む`trial_parameters`: [Sweep](/tracking/sweeps)
- コマンドの一覧: [CLI](/reference/cli)
