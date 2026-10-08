# mado-tracking

Mado Model TrackingのPython SDKとcompute worker。SDKはRunの作成、parameters/tags/metrics/logs、streaming Artifact、モデル・データセット版、学習出力の登録を扱う。workerはSSH先のjob別workspaceで実行を継続し、切断後も同じleaseとprocessへ接続する。

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

配布wheelにも例を含める。インストール後の場所は`<venv>/share/mado-tracking/examples/`。APIとつなぐSDK例は`sdk.py`、コード登録とジョブ投入は`register_job.py`を使う。SSH host key、scope、停止・復帰とAPI契約の詳細は、リポジトリの`docs/worker.md`を参照する。

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

workerはRunの`executionMode`と`executionSnapshot`をコード版へ照合し、固定されたcommandを実行する。コードを実行する前に、Run Artifactsの`.mmt/source.zip`と`.mmt/source-manifest.json`用のファイルを作成する。ZIPには実行前のsource、manifestにはjob/run/code版ID、版名、mode、検証したcommit、runtime、command、各ファイルのSHA256とsizeを記録する。コードがsourceを書き換えた場合や通常・テスト実行が失敗した場合も、同じsnapshotを回収する。sourceなしのコンテナは、固定されたimage digestまたはSIFのArtifact/hashをmanifestに保存する。environmentの値はmanifestに含めない。

ZIPは空ディレクトリも保持する。manifestには既存の`files`に加えて`directories: [{path, mode}]`を記録し、modeはPOSIX権限の整数値。復元時は権限の特殊bitを除き、所有者の読み取り・検索権限を確保する。read-onlyディレクトリは子ファイルを展開した後で権限を適用する。containerのsource mountはread-onlyのまま。

snapshotの回収は既存のArtifact upload経路を使い、各保存のackをprivate journalへ残す。再接続・worker再起動・Docker recoveryでは、sourceの展開やコード実行を繰り返さない。snapshotの保存に失敗したRunは成功扱いにせず、コードが失敗した場合のexit codeとerrorも保持する。旧worker journalで実行modeとsnapshotの両方が無い場合だけ、通常実行として扱う。

不正なclaimはJob/leaseのUUIDとworkerの所有を確認でき、claimedかつjournal・監視・recoveryの記録が無い場合に限り、実行せずfailedとして完了する。不正なresume、running状態、既存journalまたは監視中のJobは診断を残し、leaseを解放しない。保存済み正常snapshotがあればその監視を継続し、復帰できないJobは以後のclaim対象から外して他のJobの処理を続ける。対象Jobの状況とjournalを確認し、復旧または停止確認後の処理を行う。ID/lease/所有を確認できないclaim応答は`ConfigurationError`、resumeではその行を診断して他の行を処理する。

sourceはパストラバーサル、`.git`への編集・追加・削除、symlink、hardlink、特殊ファイル、重複削除、追加と削除の衝突を拒否する。sourceは一時ディレクトリで完成後に確定する。worker側の上限は、UTF-8のinline/overlayが16MiB、source全体が4GiB、1ファイルが256MiB、ファイルとディレクトリの合計が100,000、manifestが16MiB。archiveとsnapshot ZIPは、source上限にUTF-8名・ZIP64・圧縮増分の予算を加えた同じ上限を使い、上限内のZIPを復元できる。上限の定数は`src/mado_tracking/worker/source_tree.py`に集約する。APIで登録するinline/overlayは、全体3MiB、1ファイル2,000,000 bytes、1,000ファイルまで。snapshot作成・転送・uploadは分割して処理する。
