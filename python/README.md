# mado-tracking

mado ML TrackingのPython SDKとcompute worker。SDKはRunの作成、parameters/tags/metrics/logs、streaming Artifact、モデル・データセット版、学習出力の登録を扱う。workerはSSH先のjob別workspaceで実行を継続し、切断後も同じleaseとprocessへ接続する。

Python 3.11以上が必要。workerとcompute targetはLinuxを使う。リポジトリのrootで次を実行する。

```bash
python3 -m venv python/.venv
python/.venv/bin/python -m pip install -e 'python[telemetry]'
```

SDKの接続先は`MMT_API_URL`、Bearer tokenは`MMT_API_TOKEN`。workerには再起動後も同じ`MMT_WORKER_ID`とstate directoryを渡す。起動コマンドは`mado-tracking-worker`。local executorは開発時に`MMT_ALLOW_LOCAL_EXECUTOR=true`を指定して使う。

CPUだけで動く例:

```bash
python/.venv/bin/python python/examples/training.py --offline --output python/.venv/weights.json
python/.venv/bin/python python/examples/inference.py --offline --weights python/.venv/weights.json --output python/.venv/predictions.json
```

`run.log_artifact(path)`は64MiB以上のファイルを再開可能なupload sessionで送り、中断後に呼び直すと欠けたpartだけを送る。`run.log_artifacts(directory)`はディレクトリ以下をまとめて送る。`client.download_artifact_to(project_id, artifact_id, stream)`は切断後にRangeで再開し、全体のSHA-256を照合する。詳細は`docs/worker.md`の「大きなArtifactは再開可能なupload sessionで送る」を参照する。

配布wheelにも例を含める。インストール後の場所は`<venv>/share/mado-tracking/examples/`。APIとつなぐSDK例は`sdk.py`、コード登録とジョブ投入は`register_job.py`を使う。SSH host key、scope、停止・復帰とAPI契約の詳細は、リポジトリの`docs/worker.md`を参照する。

連鎖で起動した評価Jobのコードは、上流（推論）RunのArtifactsを`download_upstream_artifacts(destination, prefix=None)`でpathを保ったまま取得できる。上流RunのIDは`upstream_run_id()`（環境変数`MMT_UPSTREAM_RUN_ID`。上流が無ければNone）、一覧は`list_upstream_artifacts(prefix=None)`。取得は`download_artifact_to`と同じく切断後にRangeで再開し、SHA-256を照合してから一時ファイルを置き換える。

Gitのコード版は、固定commitのファイルを残して編集・追加・削除を適用する。`register_code`と`create_code_version`は`test_entrypoint`を受け取り、既定値は空の配列。通常実行は`entrypoint`、テスト実行は保存済みの`test_entrypoint`を使う。

```python
from mado_tracking import Client

with Client() as client:
    code = client.register_code(
        "project-id",
        name="training",
        version="v2",
        source={
            "kind": "git",
            "url": "https://example.invalid/training.git",
            "commit": "0123456789abcdef0123456789abcdef01234567",
            "files": {"main.py": "print('edited code')\n"},
            "deletedFiles": ["old.py"],
        },
        entrypoint=["python", "main.py"],
        test_entrypoint=["python", "-m", "unittest", "discover"],
        supported_model_families=["linear"],
        task_types=["training"],
    )
    task = client.create_task(
        "project-id",
        experiment_id="experiment-id",
        name="training",
        kind="training",
        code_version_id=code["id"],
        target_id="target-id",
        parameters={"steps": 3},
    )
    execution = client.launch_task(
        "project-id", task["id"],
        expected_revision=task["revision"],
        execution_mode="test",
    )
```

Taskは`list_tasks`、`get_task`、`update_task`、`list_task_runs`で一覧・取得・編集・実行履歴を扱う。`update_task(..., expected_revision=..., changes={"name": "変更後"})`の`changes`はAPIのfield名を使う。編集とlaunchには、取得したrevisionを渡す。409を受けた場合はTaskと履歴を取得し直して判断する。launchの応答が失われても、SDKは自動で再送しない。launchで省略したfieldはTaskの既定値を使い、`model_version_id=None`はモデルを外す。`gpu_ids=[]`と`input_dataset_version_ids=[]`は配列を空にする。Taskを使わずRunを作る場合も、`create_run(..., execution_mode="test")`を指定できる。

`list_task_runs`は履歴APIの全ページを取得してlistを返す。`nextCursor`がnull、またはページ分割前のAPIで省略されたときに終了する。同じcursorの繰り返しや不正なcursorは`ConfigurationError`にする。

Runの検索は`search_runs`を使う。

```python
from mado_tracking import Client

with Client() as client:
    for run in client.search_runs(
        "project-id",
        filter="metrics.loss < 0.1 AND params.lr = '0.01'",
        order_by=["metrics.loss ASC"],
        experiment_ids=["experiment-id"],
        page_size=200,
    ):
        print(run["id"], run["name"], run["latestMetrics"].get("loss"))
```

`search_runs`は`POST /projects/:p/runs/search`を`nextCursor`が無くなるまで辿るiteratorで、ページは使う分だけ取得する。filterとorder_byはMLflowの`search_runs`と同じ構文。paramsは文字列として比べる（`params.batch_size = '32'`）。`page_size`は1〜500（既定100）。cursorの扱いは`list_task_runs`と同じ。

`search_runs`は`kinds`、`statuses`、`model_version_ids`、`input_dataset_version_ids`、`parent_run_id`、`name`でも絞り込める。同じ条件で検索結果をCSVへ保存するのが`export_runs_csv`、Runを並べて比べるのが`compare_runs`と`export_comparison_csv`。

```python
with Client() as client:
    client.export_runs_csv(
        "project-id", "runs.csv",
        filter="metrics.wer < 0.2", kinds=["evaluation"], statuses=["finished"],
    )
    comparison = client.compare_runs(
        "project-id", ["run-b", "run-a"], baseline_run_id="run-a", metric_keys=["wer"],
    )
    client.export_comparison_csv("project-id", "compare.csv", run_ids=["run-b", "run-a"], baseline_run_id="run-a")
```

CSVはAPIの応答をそのままstreamでファイルへ書く（UTF-8 BOM付き、行数の上限はAPIの設定で既定50000行、打ち切りはCSVの末尾に示される）。書き込みは一時ファイルで行い、全体を受け取ってから置き換えるので、途中で切れても前のファイルは残る。接続が切れたときは最初から取り直す。

### モデルのalias・評価・昇格・自動実行

機能ごとの関数は`mado_tracking.aliases`、`evaluation`、`automation`、`exports`、`service_accounts`にあり、`Client`の同名メソッドとして呼べる。

```python
from mado_tracking import Client
from mado_tracking.evaluation import reference_dataset_version_ids

with Client() as client:
    client.set_model_alias("project-id", "model-id", "production", version_id="version-id", reason="WERが改善")
    for event in client.list_alias_events("project-id", "model-id", alias="production"):
        print(event["createdAt"], event["previousVersionId"], "->", event["versionId"], event["source"])
    client.delete_model_alias("project-id", "model-id", "staging", reason="検証終了")

    comparison = client.compare_to_baseline("project-id", "model-id", "candidate-version-id", metrics=["wer"])
    if comparison["status"] == "ok":
        print({row["key"]: row["delta"] for row in comparison["metrics"]})

    inference = client.create_automation_rule(
        "project-id", name="inference", model_families=["whisper"], kind="inference",
        experiment_id="experiment-id", code_version_id="inference-code-version-id", target_id="target-id",
    )
    evaluate = client.create_automation_rule(
        "project-id", name="evaluate", model_families=["whisper"], kind="evaluation",
        experiment_id="experiment-id", code_version_id="evaluation-code-version-id", target_id="target-id",
        trigger="upstream_run_finished", upstream_rule_id=inference["id"],
        input_dataset_version_ids=["reference-dataset-version-id"], summary_metrics=["wer", "cer"],
    )
    client.create_promotion_policy(
        "project-id", name="WERで昇格", model_id="model-id", target_alias="production",
        evaluation_rule_id=evaluate["id"],
        criteria=[{"metric": "wer", "direction": "lower", "mode": "delta", "threshold": 0.0}],
    )
    for judgement in client.list_promotion_evaluations("project-id", model_id="model-id"):
        print(judgement["candidateVersionId"], judgement["decision"])

    executions = client.list_automation_executions("project-id", model_version_id="version-id")
    client.apply_automation_rule("project-id", inference["id"], model_version_id="older-version-id")

    run = client.get_run("project-id", "evaluation-run-id")
    print(reference_dataset_version_ids(run))  # 正解セット（入力から上流Runの出力を除いたもの）
```

- `list_alias_events`と`list_promotion_evaluations`は`nextCursor`を辿るiteratorで、ページは使う分だけ取得する。`list_automation_executions`は全ページを読んでlistを返す（ページ分割前のAPIは最新100件の1ページ）。
- `set_model_alias(..., evaluation_id=...)`は合格した昇格判定のIDを`promotionEvaluationId`として送る。指定したときだけ送る。
- `apply_automation_rule`は登録起動のruleなら`model_version_id`、連鎖のruleなら`trigger_run_id`（上流Run）のどちらか1つを渡す。Project adminだけが実行できる。
- `create_automation_rule`の`max_attempts`の既定は1。`trigger`と`upstream_rule_id`は組で指定する。

### Service Accountと所有者の移管

人の異動で自動実行が止まらないように、rule・policy・フックをService Accountの権限で動かす。どれもProject adminの操作。移管先のService Accountのroleは、ruleとpolicyがadmin、フックがeditorかadmin（`worker:execute`のtokenもadminにだけ発行できる）。

```python
from datetime import UTC, datetime, timedelta

with Client() as client:
    account = client.create_service_account("project-id", name="pipeline", role="admin")
    issued = client.create_service_account_token(
        "project-id", account["id"], name="worker", scopes=["read", "worker:execute"],
        expires_at=datetime.now(UTC) + timedelta(days=90),
    )
    # issued["token"] はこの応答でしか返らない。安全な場所へ保存する。
    client.transfer_automation_rule_owner("project-id", "rule-id", service_account_id=account["id"])
    client.transfer_promotion_policy_owner("project-id", "policy-id", service_account_id=account["id"])
    client.transfer_hook_owner("project-id", "hook-id", service_account_id=account["id"])
    for token in client.list_project_tokens("project-id"):
        print(token["ownerType"], token["ownerName"], token["tokenPrefix"], token["expiresAt"])
```

`expires_at`はtimezone付きのdatetimeで渡す。省略するとAPIの上限（既定365日）になる。token発行と作成系の操作は、応答が失われても再送しない（tokenが二重に発行されるのを避ける）。alias設定と所有者の移管は同じ値の再送で結果が変わらないので、一時的な失敗のときに再送する。

### 学習の途中再開（checkpoint）

詳細は`docs/worker.md`の「学習を途中から再開する（checkpoint）」を参照する。

- `run.log_checkpoint(directory, step=, includes_optimizer=False, framework=None, metadata=None)`: ディレクトリをtar 1個にしてupload sessionで保存し、Runのcheckpointとして登録する。
- `run.resume_checkpoint()`: 再開Jobならcheckpointの展開先（read-only）とstepを`ResumeCheckpoint`で返す。再開でなければNone。APIなしでは`mado_tracking.checkpoints.resume_checkpoint_from_environment()`。
- 再開後もmetricの`step`は続きの値（checkpointのstepから）で記録する。

### Runの再開・オフライン記録・システムメトリクス

```python
import mado_tracking

# 同じRunに追記する。'must'は既存Runだけ、'allow'は無ければそのIDで作る。
run = mado_tracking.start_run(project_id="project-id", run_id="run-id", resume="must")
run.log_metrics({"loss": 0.12})  # stepを省略すると、keyごとに前回の最大step+1で記録する
run.finish()

# APIに届かない計算機ではローカルに記録し、後で送る。
with mado_tracking.start_run(
    project_id="project-id", experiment_id="experiment-id", name="offline", mode="offline",
    system_metrics=True,
) as run:
    run.log_metrics({"loss": 0.5}, step=1)
    run.log_artifact("model.bin")
```

```bash
mado-tracking sync                    # MMT_OFFLINE_DIR（既定 ~/.local/share/mado-tracking/offline）の全Run
mado-tracking sync DIR --dry-run      # 送る予定の件数だけ表示（APIに接続しない）
mado-tracking sync --project-id P --prune   # Project Pの分だけ送り、送り終えたRunのspoolを消す
```

- **再開**: `start_run(run_id=, resume='never'|'allow'|'must')`。既定の`'never'`は従来どおり新しいRunを作る（`run_id`だけを渡すと`ConfigurationError`）。`'must'`は`POST /projects/:p/runs/:r/resume`で終わったRunをrunningへ戻し、Runが無ければ`ConfigurationError`。`'allow'`はRunが無ければ`PUT /projects/:p/sync/runs/:runId`でそのIDのRunを作る（`experiment_id`と`name`が要る。指定できる属性は`parameters`・`tags`・`parent_run_id`）。再開ごとにAPIへ再開イベントが残り、Runの区間（segments）として表示される。
- **stepの続き（挙動の変更）**: 再開したRunでは、`log_metrics`の`step`を省略するとkeyごとに前回の最大step+1を使う（初めてのkeyは0）。`run.last_step(key)`で今の最大stepを読める。新しく作ったRunで`step`を省略した場合は、従来どおり0のまま。
- **workerのRunは再開しない**: `MMT_RUN_ID`か`MMT_JOB_ID`がある環境での`resume`と、Jobが付いたRun（API の409 `run_finalized`）は`ConfigurationError`。Jobのcheckpointからretryし、`run.resume_checkpoint()`で続ける（「学習の途中再開（checkpoint）」）。
- **モード**: `start_run(mode=)`、無ければ環境変数`MMT_MODE`（既定`online`）。`offline`はAPIに一度も接続せず、`MMT_API_URL`・`MMT_API_TOKEN`も要らない。Run IDはSDKがUUIDで決める。`auto`はonlineで始め、接続できない（接続失敗、または5xxの再試行切れ）と、そのRunだけofflineに切り替えて記録を続け、終了時に`mado-tracking sync`の案内を出す。切り替え前にAPIへ送れた分はspoolに書かない。切り替えのきっかけになった1件は、APIに届いていた可能性があっても送り直す（失うより重複を選ぶ）。Runの作成そのものが届かなければ、最初からofflineで記録する。workerのJob内（`MMT_JOB_ID`がある）では`offline`を拒否する。
- **offlineで使えないもの**: Run作成時の`model_version_id`などsyncで送れない属性、再開、モデル・データセットの登録、checkpoint。いずれも`ConfigurationError`。
- **spool**: `MMT_OFFLINE_DIR/<runId>/`に`run.json`（作成情報）、`batches/<sequence>-<batchId>.jsonl`（1行1レコード）、`artifacts.jsonl`、`media.jsonl`、`status.json`、`sync-state.json`を置く。ファイルは600、ディレクトリは700。tokenは書かない（logの本文も従来どおりsecretを伏せる）。batchの各行は書くたびにflushし、fsyncは50行（`SPOOL_FSYNC_EVERY`）ごとと、Runの終了時に行う。電源断で失うのは最後の数十行まで。batchは5000行か16MiBで次のファイルに分かれる（APIの1 batchの上限より小さい）。
- **Artifact**: offlineの`log_artifact`は既定でspoolの`artifact-files/<sha256>`へ複製する（spoolのディレクトリごと別の計算機へ移してsyncできる）。`copy=False`は元のファイルのpathとsha256だけを記録し、syncのときに中身が変わっていればそのRunの送信を止める。
- **media**: `media.jsonl`の1行は`{id, key, step, kind, artifactPath, caption, metadata}`。`artifactPath`は同じRunで`log_artifact`したpath。syncは`POST /projects/:p/runs/:r/media`へ`id`付きで送る。
- **sync**: Runごとに`PUT /sync/runs/:id` → batchをsequence順に → `artifacts/check`でpresentと返らなかったArtifactを再開可能なupload sessionで → media → 最後に終了状態。終了状態を最後に送るので、Run終了時の自動処理（出力登録など）はArtifactが揃ってから動く。各段階のあとに`sync-state.json`を更新するので、途中で失敗しても次の`mado-tracking sync`はそこから続く。同じディレクトリを2回syncしてもAPI側は増えない（Run ID・batchId・Artifactのsha256・media idで重複を判定する。`sync-state.json`を失っても送り直すだけで済む）。記録中のRun（書き込み側がlockを持っている）は飛ばす。終了状態の無いRunは送るがrunningのまま残し、完了扱いにしない。tokenには`runs:write`と`artifacts:write`が要る。失敗したRunがあれば終了コードは1。
- **システムメトリクス**: `start_run(system_metrics=True, system_metrics_interval=None)`で、GPU/CPU/メモリ/ディスク/ネットワークを`system.*`のmetricとして一定間隔（既定15秒、最短1秒）で記録する。送り先はRunと同じ（offlineならspool）。`finish`と`with`の終了で止まり、終了状態のあとに標本は届かない。`MMT_SYSTEM_METRICS=false`で止められる。workerのJob内（`MMT_JOB_ID`がある）ではworkerのtelemetryと重なるので起動しない。`run.start_system_metrics()`で後から始めることもできる。stepは0から数えるので、再開したRunでは`system.*`のstepが前の区間と重なる。
- **例**: `examples/research_features.py`（system metrics、10 stepごとのmedia、checkpoint、`--resume RUN_ID`での再開。`MMT_MODE=offline`ならAPIなしでspoolへ記録し、後で`mado-tracking sync`で送る）。

| やりたいこと | Mado | W&B | MLflow |
| --- | --- | --- | --- |
| 同じRunに追記 | `start_run(run_id=..., resume="must")` | `wandb.init(id=..., resume="must")` | `mlflow.start_run(run_id=...)` |
| 無ければ作る | `resume="allow"` | `resume="allow"` | （無い） |
| 再開の記録 | 再開イベント（`source:'native'`） | — | 同じ再開イベント（`source:'mlflow'`） |
| オフライン記録 | `mode="offline"`または`MMT_MODE=offline` | `WANDB_MODE=offline` | （無い） |
| 後で送る | `mado-tracking sync [DIR]` | `wandb sync [DIR]` | （無い） |
| システムメトリクス | `start_run(system_metrics=True)` | 既定で有効 | `mlflow.enable_system_metrics_logging()` |
| 既定と止め方 | 既定で無効。`MMT_SYSTEM_METRICS=false`でコードの指定も止める | 既定で有効。`wandb.init(settings=...)`で止める | 既定で無効（`MLFLOW_ENABLE_SYSTEM_METRICS_LOGGING`で切替） |

### stepごとの音声・画像・表・動画（media）

```bash
python3 -m pip install 'mado-tracking[media]'   # numpy配列とPIL画像を渡すときだけ（numpy、Pillow）
```

```python
import numpy as np
import mado_tracking
from mado_tracking import Audio, Table

with mado_tracking.start_run(project_id="project-id", experiment_id="experiment-id", name="tts") as run:
    for step in range(1, 1001):
        run.log_metrics({"loss": loss}, step=step)
        if step % 100:
            continue
        # stepを省くと、最後にlog_metricsしたstep（再開したRunでは続きのstep）で記録する
        run.log_audio("inference/sample", waveform, sample_rate=16000, caption="prompt 1")
        run.log_image("inference/spectrogram", mel)          # HxWのfloat [0,1]
        run.log_table("evaluation/samples", Table(
            columns=["audio", "transcript", "score"],
            rows=[[Audio(wav, sample_rate=16000), text, score] for wav, text, score in samples],
        ))
```

- **入力**: `log_audio`はpath・bytes（WAV・FLAC・MP3・OGG・M4A）・numpy配列（floatは[-1,1]を16bit PCM、範囲外はclip。int16はそのまま。`(frames,)`か`(frames, channels)`のmono/stereo。`sample_rate`が必須）。`log_image`はpath・bytes・numpy配列（HxW／HxWx3／HxWx4。uint8、floatは[0,1]）・PIL.Image。`log_video`はpath・bytesだけで、変換はしない（ブラウザで再生できるmp4（H.264）かwebmを推奨）。種類は拡張子、無ければ先頭bytesで判定し、別の種類のファイル（`log_image`に音声など）や判定できないbytesは`ConfigurationError`。numpy配列のWAV化・PNG化は標準ライブラリで行うので、numpy・Pillow・pandasが無い環境でもpathとbytesは使える。値クラス`Audio`・`Image`・`Video`（`caption=`付き）を直接渡してもよい。
- **表**: `log_table(key, table, step=)`は`Table(columns, rows)`、MLflowのsplit形式の`{columns, data}`、pandas.DataFrameを受け取る。セルの`Audio`・`Image`・`Video`は表と同じ場所へ別のArtifactとして保存し、表はMLflow `log_table`と同じ`orient='split'`のJSONに`{type:'audio'|'image'|'video', filepath}`のセルを入れて保存する。別のRunのArtifactは`artifact_reference(run_id, path)`（文字列`mmt-artifact://runs/<runId>/<path>`）をセルに置く。NaNはnullになる。
- **保存場所と登録**: ファイルは`media/<key>/step-<step>/<uuid>.<拡張子>`のArtifact（keyの`/`はそのまま階層になり、Artifact一覧でも辿れる）。保存のあと`POST /projects/:p/runs/:r/media`で登録する。media idはSDKがUUIDで決めるので、応答が失われた再送でも件数は増えない。metadataには、配列から作った音声は`{sampleRate, channels}`、画像は`{width, height}`、表は`{rowCount, columnCount}`が入る。keyは1〜250文字で、空・`.`・`..`の区切り、バックスラッシュ、制御文字、`%xx`は使えない。
- **オフライン**: `mode="offline"`ではファイルをspoolへ複製して`media.jsonl`に書き、`mado-tracking sync`がArtifactのあとに同じidで登録する。`mode="auto"`で登録がAPIに届かなければ、ファイルごとspoolへ記録し直す。
- **例**: `examples/media_logging.py`（100 stepごとに推論音声・スペクトログラム・評価表を記録する。`--mode offline`でAPIなしに動く）。

| やりたいこと | Mado | MLflow |
| --- | --- | --- |
| stepつきの画像 | `run.log_image(key, image, step=)` | `mlflow.log_image(image, key=, step=)` |
| 音声 | `run.log_audio(key, data, step=, sample_rate=)` | （無い。`log_artifact`） |
| 動画 | `run.log_video(key, path, step=)` | （無い。`log_artifact`） |
| 表 | `run.log_table(key, table, step=)` | `mlflow.log_table(data, artifact_file=)`（stepなし） |
| 表の中の画像 | セルに`Image(...)`（音声・動画も可） | DataFrameのセルにPIL画像 |

MLflowの`log_image(key=, step=)`と`log_table`で記録したものも、同じmediaの画面（stepのスライダー、表）に出る（`docs/api-contract.md`の「Runのmedia」）。

### Sweep

- 学習コードで試行のparametersを読む: `from mado_tracking import trial_parameters` → `trial_parameters({"lr": 0.05})`。`MMT_PARAMETERS_JSON`（無ければ`MMT_PARAMETERS_FILE`）をdefaultsに上書きして返す。workerの外ではdefaultsをそのまま返す。値はJSONの型のまま。
- Sweepの作成・一覧・最良試行・pause/resume/cancel: `SweepsClient(Client())`。configはW&B形式（変換規則は`docs/sweeps.md`の「W&B 形式の config の変換規則」）。
- 例: `examples/sweep_training.py`（`--offline`でAPIなしに試せる）。

### ディレクトリからデータセット版を作る

`register_dataset(..., files="data/speech")`はディレクトリの中身をArtifactsとして送り、APIがuriとdigestを決める。`files`を使うときは`uri`、`digest`、`source_run_id`、`parent_dataset_version_ids`、`external_ref`を指定しない。既存のDatasetへ版を足すだけなら、同じ処理を`upload_dataset_directory`で直接呼べる。

```python
from mado_tracking import Client
from mado_tracking.dataset_upload import upload_dataset_directory

with Client() as client:
    version = upload_dataset_directory(
        client, "project-id", "dataset-id", "corpus/",
        version=None,                 # None なら整数で自動採番
        metadata={"language": "ja"},
        schema={"sampleRate": 16000},
    )
```

- ディレクトリ配下の全ファイルをProjectのArtifact（`datasets/<datasetId>/<相対パス>`）として保存し、1回の`POST /datasets/:d/versions`（`content.files`）で`contentKind='artifacts'`の版を作る。版の`uri`は`mmt-dataset://<版のID>`。
- uploadの前に`GET /artifacts/by-digest?sha256=&size=`を引き、同じ中身の保存済みArtifactがあればuploadせずにそのIDを使う。中断後に再実行すると、未保存のファイルだけを送る。
- 64MiB以上のファイルは再開可能なupload sessionを使う。
- ローカルで計算したdigestを送るので、保存されたArtifactが手元のファイルと違えばAPIが422 `dataset_digest_mismatch`で拒否する。同じ`version`の再作成は409。
- ファイル数の上限は10万件（超えるとupload前に`ConfigurationError`）。

### workerの実行前sourceとsnapshot

workerはRunの`executionMode`と`executionSnapshot`をコード版へ照合し、固定されたcommandを実行する。コードを実行する前に、Run Artifactsの`.mmt/source.zip`と`.mmt/source-manifest.json`用のファイルを作成する。ZIPには実行前のsource、manifestにはjob/run/code版ID、版名、mode、検証したcommit、runtime、command、各ファイルのSHA256とsizeを記録する。コードがsourceを書き換えた場合や通常・テスト実行が失敗した場合も、同じsnapshotを回収する。sourceなしのコンテナは、固定されたimage digestまたはSIFのArtifact/hashをmanifestに保存する。environmentの値はmanifestに含めない。

ZIPは空ディレクトリも保持する。manifestには既存の`files`に加えて`directories: [{path, mode}]`を記録し、modeはPOSIX権限の整数値。復元時は権限の特殊bitを除き、所有者の読み取り・検索権限を確保する。read-onlyディレクトリは子ファイルを展開した後で権限を適用する。containerのsource mountはread-onlyのまま。

snapshotの回収は既存のArtifact upload経路を使い、各保存のackをprivate journalへ残す。再接続・worker再起動・Docker recoveryでは、sourceの展開やコード実行を繰り返さない。snapshotの保存に失敗したRunは成功扱いにせず、コードが失敗した場合のexit codeとerrorも保持する。旧worker journalで実行modeとsnapshotの両方が無い場合だけ、通常実行として扱う。

不正なclaimはJob/leaseのUUIDとworkerの所有を確認でき、claimedかつjournal・監視・recoveryの記録が無い場合に限り、実行せずfailedとして完了する。不正なresume、running状態、既存journalまたは監視中のJobは診断を残し、leaseを解放しない。保存済み正常snapshotがあればその監視を継続し、復帰できないJobは以後のclaim対象から外して他のJobの処理を続ける。対象Jobの状況とjournalを確認し、復旧または停止確認後の処理を行う。ID/lease/所有を確認できないclaim応答は`ConfigurationError`、resumeではその行を診断して他の行を処理する。

sourceはパストラバーサル、`.git`への編集・追加・削除、symlink、hardlink、特殊ファイル、重複削除、追加と削除の衝突を拒否する。sourceは一時ディレクトリで完成後に確定する。worker側の上限は、UTF-8のinline/overlayが16MiB、source全体が4GiB、1ファイルが256MiB、ファイルとディレクトリの合計が100,000、manifestが16MiB。archiveとsnapshot ZIPは、source上限にUTF-8名・ZIP64・圧縮増分の予算を加えた同じ上限を使い、上限内のZIPを復元できる。上限の定数は`src/mado_tracking/worker/source_tree.py`に集約する。APIで登録するinline/overlayは、全体3MiB、1ファイル2,000,000 bytes、1,000ファイルまで。snapshot作成・転送・uploadは分割して処理する。

### 外部の計算機（site）: runner・launcher・手動投入

siteは、スーパーコンピュータやGPUサーバー、研究者のPCのように、siteのjob shellで投入する計算機（`ComputeTarget.executor='site'`）です。接続先・job shell（版つき）・作業ディレクトリ・runner・取消コマンドなどの全体設定と、各人のアカウント名・作業ディレクトリ・変数（個人設定）は、trackingのWebで管理します。自動投入のsiteではlauncherが、手動投入のsite（ログインに一時パスワードが要るsiteや研究者のPC）では本人の`mado-tracking submit`がjob shellを動かし、計算ノードのrunnerがJob tokenでAPIへ直接報告します。説明は`docs/sites.md`、job shellの例は`deploy/sites/`にあります。

**runner（`mado-tracking site-run <spec dir>`）**

- launcherと`submit`は、作業ディレクトリに`.mmt-runner/<版>/mmt-runner.pyz`（このpackageとhttpxを含むzipapp）と`mmt-runner`（起動用のshell script）を版ごとに一度だけ置きます。job shellは`"$MMT_RUNNER" "$MMT_SPEC_DIR"`を起動します。計算ノードにはPython 3.11以上だけが要ります（siteの設定のrunnerのPython、または環境変数`MMT_RUNNER_PYTHON`）。
- 仕様の置き場（`.mmt-submissions/<最初のJob ID>/`、700）には`submission.json`（tokenなし。job shellは`id`・`version`・`sha256`だけで、内容は入れません）、`api.json`（`apiUrl`）、`runner.json`（作業ディレクトリ、GPUの割り当て方など）、`jobs/<i>.json`（WorkerJobとJob token、600）、任意の`secrets.json`（`registry`）があります。runnerは`MMT_ARRAY_INDEX`（無ければ0）番目のJobを動かします。
- 流れは`runner/start`（phase `waiting_resources`）→ 入力の用意 → GPUの割り当て → heartbeatでphase `running` → コンテナ → 出力の検証とupload（`container/<path>`、64MiB以上はupload session）→ metrics・宣言 → `runner/finish`です。heartbeatは5秒ごとで、`cancelRequested`ならコンテナを止めて`canceled`で終えます。heartbeatが拒否された（401・410など）ときは、コンテナを止めてfinishを送らずに終わります。SIGTERMでは、コンテナを止めて`endReason: timed_out`で終えます。
- 入力はworkerの直接転送（`datasetTransfer='direct'`）と同じ処理で用意します。`datasetPartitionVersionId`の版は、path順で`位置 % arraySize == arrayIndex`のファイルだけを取ります。SIFのArtifactと、Dockerのimageを変換したSIF（`apptainer pull --arch <cpuArch>`、registryの認証は`secrets.json`から`APPTAINER_DOCKER_USERNAME`・`APPTAINER_DOCKER_PASSWORD`で渡します）は、`<作業ディレクトリ>/.mmt-cache/sif/`にdigestとCPUの組ごとに1つ置き、lockで1回だけ取得します。
- フックの入力: `inputCheckpoint`は`/mmt/inputs/checkpoint`（read-only、`MMT_INPUT_CHECKPOINT_DIR`・`MMT_INPUT_CHECKPOINT_FILE`）、`triggerPayload`は`/mmt/context/trigger-payload.json`（`MMT_TRIGGER_PAYLOAD_FILE`）に置きます。再開のcheckpointもあるJobでは、入力のcheckpointは`/mmt/inputs/input-checkpoint`になります。SSHのworkerも同じ変数とファイルを渡します。
- GPU: スケジューラのあるsiteでは、スケジューラが渡した`CUDA_VISIBLE_DEVICES`を使います。直実行のホスト（siteの設定でGPUの渡し方が`lease`）では、`nvidia-smi`で空いたGPU（選んでよいGPUを設定したときはその中）を選びます。他のrunnerがleaseしているGPUと、Madoのlabelが付いた動いているDockerコンテナが持つGPUは使いません。足りない間はphase `waiting_resources`のまま待ちます。
- 終了コードは、成功で0、失敗・取消・時間切れで1、設定の誤りで2、APIがJobを受け付けなかった（終了済み・別のrunner・tokenの失効）ときに3です。

**launcher（`mado-tracking-launcher --config launcher.toml`）**

launcherは全体管理者がWebで登録し、そのとき一度だけ表示されるtoken（`mmt_…`）をファイルに置きます。どのsiteを担当するかは、Webでsiteの設定にlauncherを選んで決めます。`launcher.toml`（`--config`か`MMT_LAUNCHER_CONFIG`）には起動に要るものだけを書きます。相対pathはこのファイルのディレクトリから読みます。

```toml
api_url = "https://tracking.example.org"     # launcherから見たAPI
token_file = "/run/secrets/mado-tracking-launcher/launcher.token"   # mode 600。グループ・他人が読めると起動しない
state_directory = "/var/lib/mado-tracking-launcher"   # 秘密鍵・known_hosts・未送信の報告。再起動をまたいで残す
poll_seconds = 10                             # 省略で10
# registry_secret_file = "/run/secrets/mado-tracking-launcher/forge-pull.json"   # 任意。全siteのrunnerがSIFへの変換に使う
```

- `state_directory`は必須です。launcherの秘密鍵を置くので、launcherごとに別のディレクトリを使い、消さないでください（消すと鍵を作り直し、siteへの公開鍵の登録もやり直しです）。`registry_secret_file`はmode 600のJSON（`{"username", "password"}`）で、投入のたびに読み直します。
- `[[projects]]`・`[[sites]]`（`[sites.connection]`・`local = true`・`[sites.accounts]`）・`launcher_id`は読みません。書いてあると、Webへ移ったことを示すエラーで起動しません。知らないkeyも起動しません。tokenはファイルからだけ読み、コマンドの引数やログに出しません。
- 1回の巡回は、未送信の報告の再送 → `GET /api/launcher/config`（担当の自動投入のsite・鍵・接続確認）→ 鍵の同期 → 接続確認 → siteごとの投入 → 待ち行列での取消、の順です。APIはtokenでlauncherを知るので、どの要求もlauncherのIDを送りません。
- 鍵: `state_directory/keys/`（700）に、APIが挙げた鍵ごとに秘密鍵`<keyId>`（600）と公開鍵`<keyId>.pub`を`ssh-keygen -q -t ed25519 -N '' -C 'mmt-launcher:<launcher名>:<keyId>'`で作り、公開鍵だけを`PUT /api/launcher/keys/<keyId>`で送ります。秘密鍵はlauncherのホストから出ません。`requested`のままの鍵や、APIの持つ公開鍵が手元と違う鍵は送り直し、半分しか無い鍵は作り直し、APIが挙げなくなった鍵（失効・作り直し）のファイルは消します。Webに出る公開鍵を、siteのアカウントの`~/.ssh/authorized_keys`に登録します。
- 接続確認: Webで頼まれた確認ごとに、そのアカウントと鍵で、共有の接続を使わずに1回ログインして`true`だけを実行し、成否を`POST /api/launcher/connection-checks/<id>`で送ります。失敗のときは、sshの標準エラーの末尾（tokenは伏せる、2000文字まで）を添えます。
- 投入: siteごとに`POST /api/launcher/site-submissions/claim`（`targetIds`とsiteの`maxActiveSubmissions`）で受け取り、各submissionに付いた設定で投入します。SSHのユーザーは`account.accountName`、鍵は`account.keyId`の鍵です。host keyは、siteの設定のknown_hosts（`state_directory/known-hosts/<siteのID>`、600に書きます）に載ったものだけを受け入れます。known_hostsが空のsiteや接続先の無いsiteは、理由を添えて`failed`を報告します。作業ディレクトリと変数は`account`（個人の設定が全体の設定の上に乗ったもの）、job shellは`jobShell`（Jobが記録した版）、runnerのPython・runnerから見たAPIのURL・GPUの渡し方・取消の猶予・出力の上限は`settings`から取ります。作業ディレクトリへrunnerとjob shellを入れ、仕様の置き場を書き、job shellを1回だけ動かして、標準出力の最後の行をスケジューラのジョブIDとして報告します。job shellが0以外で終わったら、tokenとJob tokenを伏せた短いエラーで`failed`を報告します。届かなかった報告は`state_directory/pending-reports/`に残し、次の巡回で送り直します。
- 取消: 待ち行列で取り消されたJobは`cancellations`で受け取り、APIが示すアカウント（`account`）でsiteの取消コマンド（`MMT_SCHEDULER_JOB_ID`を渡します）を動かしてから報告します。投入したときと違うアカウントが示されたときはログに残します（スケジューラが取消を断ることがあります）。アカウントが分からないJobは待ち行列に残ります（runnerは起動するとtokenが401になり、すぐ終わります）。
- ログインの失敗: 投入か取消でSSHのログインに失敗した接続先（site・アカウント・鍵）には、その巡回の残りの投入では入らず、最初の失敗と同じ理由（`Not tried: …`）で`failed`を報告します。次の巡回ではまた試します（Jobは`submit_failed`になるので、同じJobは繰り返しません）。取消は、その接続先へ600秒のあいだ入らず、後の巡回に回します。ログインできたら記録を消します。公開鍵がsiteに登録される前（launcherや鍵を変えた直後など）に、失敗したログインが1巡回に何百回も続いて、siteにアカウントやIPを止められないためです。記録はプロセスの中だけで、再起動で消えます。
- SSHは`BatchMode=yes`・`StrictHostKeyChecking=yes`で、`state_directory/ssh/`に置く専用のssh_configを使います。経由するホスト（`ssh -J`）にも同じ鍵とknown_hostsが効きます。投入と取消の接続は（site、アカウント、鍵）ごとにControlMasterで1本を共有し、60秒使わなければ閉じます。`ssh-keygen`と`ssh`は引数を分けて起動し、shellを通しません。

**手動投入（`mado-tracking submit --site <siteのID>`）**

本人のAPI token（`MMT_API_URL`・`MMT_API_TOKEN`）で、job shellが投入できる場所（siteのログインノード、またはsiteである研究者のPC）から実行します。siteの設定・job shell・自分の作業ディレクトリと変数はWebから読みます（`GET /api/manual-submissions/sites/<siteのID>`）。待っているJobを受け取り、仕様の置き場を書き、job shellで投入して報告します。

```bash
mado-tracking submit --site <siteのID> --dry-run          # 待っている件数と使う設定を表示する（受け取らない）
mado-tracking submit --site <siteのID>                    # 1回投入して終わる。何も常駐しない
mado-tracking submit --site <siteのID> --work-dir /work/gxx/me/mmt --var GROUP=gxx50000   # この回だけの上書き
mado-tracking submit --site <siteのID> --watch --all      # PC: 止めるまで10秒ごとに、全員のJobを投入する
mado-tracking submit --site <siteのID> --registry-secret-file ~/.config/mado-tracking/pull.json   # SIFへの変換にregistryの認証を使う
```

- 各Jobは、受け取ったときのsiteの設定・job shellの版・投入する本人の作業ディレクトリと変数で投入します。`--work-dir`と`--var NAME=VALUE`はその回だけ、その上に重ねます。
- `--all`は、自分が所有する計算機で、自分以外のJobも含めて待っているJobを投入します（APIの`all`）。所有していない計算機では、受け取る前に止まります。`--all`で受け取るのは、使ったtokenのProjectのJobだけです（書き込みのtokenはProjectごとに作るため）。複数のProjectに共有したときは、Projectごとにそのtokenで`--watch --all`を動かします。
- `--watch`は、`--interval`（秒、既定10、1以上）ごとに同じことを繰り返します。APIの一時的な失敗（接続できない、5xx、408、429）は表示して続け、tokenの失効などの拒否と設定の誤りで止まります。最初のSIGINT（Ctrl-C）かSIGTERMで、その回の投入と報告を終えてから止まります。2回目のCtrl-Cはすぐに止めます。job shellは別のsessionで動くので、Ctrl-Cで投入の途中に切れません。
- `--registry-secret-file PATH`は、runnerがimageをSIFへ変換するときのregistryの認証です。中身はlauncherの`registry_secret_file`と同じJSON（`{"username", "password"}`）で、mode 600にします（グループ・他人が読めると、Jobを受け取る前に止まります）。回ごとに読み直し、runnerには仕様の置き場の`secrets.json`（600）で渡ります。passwordは表示とJobのエラーに出しません。
- `--limit`は1回に受け取る数（1〜50）です。`--job-shell`・`--config`・`submit.toml`はありません（job shellはWebで版として管理します）。
- job shellの無いsiteや、作業ディレクトリが決まっていない（Webの設定に無く、`--work-dir`も無い）ときは、Jobを受け取らずに止まります。
- 届かなかった報告は`~/.local/state/mado-tracking/submit/<siteのID>/pending/`（`XDG_STATE_HOME`）に残り、次の実行（`--watch`では次の回）で送り直します。tokenは表示に出しません。

**ドライバー・フック・array（SDK）**

```python
from mado_tracking import ChildJobSpec, Client, map_shards

with Client() as client:  # Jobの中ではJob token（MMT_API_TOKEN）と MMT_PROJECT_ID・MMT_JOB_ID を使う
    spec = ChildJobSpec(name="shard", kind="processing", code_version_id="code-version-id", target_id="site-id", gpu_count=1)
    jobs = map_shards(client, spec, [{"shard": index} for index in range(64)], key="generate-v1")
    client.trigger_hook("project-id", "hook-id", {"ref": "refs/heads/main"}, idempotency_key="deploy-42")
    client.create_job_array(
        "project-id", experiment_id="experiment-id", name="generate", kind="processing",
        code_version_id="code-version-id", target_id="site-id", size=64,
        input_dataset_version_ids=["version-id"], dataset_partition_version_id="version-id",
    )
```

- 子Jobは`submit_child_job(client, spec, key=...)`で作ります。同じkeyの再送（ドライバーの再起動を含む）は、最初に作った子Jobを返します。`wait_for_child_jobs`は最長60秒のlong pollを、全部終わるまで繰り返します。`map_shards`はshardごとに`<key>:<番号>`の子Jobを作り、parametersにshardの値を足して、終わるまで待ちます。親Jobは`allowChildJobs`で作っておきます。
- `trigger_hook`はtrigger `manual`のフックを起動します。keyを省くとSDKがUUIDを付けるので、応答が失われた再送でも起動は1回です。

**ジョブの雛形から登録（`mado-tracking code register`）**

```bash
mado-tracking code register --job-file mmt-job.toml --project <Project ID> [--code <名前>] [--version <版>]
```

`mmt-job.toml`（例: `examples/mmt-job.toml`）の`image`のtagを、OCI distribution APIでdigestに解決してから、DockerのCodeVersionとして登録します。registryには匿名で、または`MMT_REGISTRY_USERNAME`・`MMT_REGISTRY_PASSWORD`でBearer tokenを受け取って問い合わせます。同じ名前のCodeがあれば、そこに版を足します。版を省くと、`version`、無ければcommitとdigestの先頭から決めます。
