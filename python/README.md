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
