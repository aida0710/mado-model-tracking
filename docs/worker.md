# Python SDKとcompute worker

`python/`の`mado_tracking`は、Runの記録と登録を行うSDK、SSH先でコードを実行するworkerを提供する。対象はAPI tokenを使う実験担当者と、compute targetを管理する担当者。API契約は[api-contract.md](api-contract.md)、型の正本は[contracts](../packages/contracts/src/index.ts)。

初回は「インストール」「SDKでRunを記録」「workerを起動」を読む。その後の節は、コード登録・復帰・停止の際に参照する。

## Python 3.11以上でインストールする

SDKはPython 3.11以上、workerとcompute targetはLinuxを使う。runnerは`/proc`でPIDの再利用を判定し、process groupで停止を管理する。SSH先にもPython 3.11以上、`venv`、`pip`、Gitが必要。SDK自体の必須依存は`httpx`だけで、`psutil`は任意。

Ubuntu / Debianのworkerマシンとcompute targetでは、必要に応じて次を実行する。

```bash
sudo apt-get update
sudo apt-get install python3 python3-venv python3-pip openssh-client git
python3 --version
```

Pythonの版が3.11未満なら、対応するPythonを別途用意する。リポジトリのrootから、専用venvにSDKとworkerを入れる。

```bash
python3 -m venv python/.venv
python/.venv/bin/python -m pip install -e 'python[telemetry]'
```

`ensurepip`が無い環境では、既に導入済みの`uv`でvenvを作れる。

```bash
uv venv python/.venv --seed
uv pip install --python python/.venv/bin/python -e 'python[telemetry]'
```

workerには`ssh`コマンドを使う。AsyncSSHは不要。compute targetにはジョブ別venvを作り、同梱SDKと`httpx`、CodeVersionの`requirements`を用意する。依存導入に失敗したジョブは`failed`になり、stderrがRunのlogsへ送られる。

## SDKでRunを記録する

`MMT_API_URL`はAPI originか`/api`までのURLを指定する。tokenをターミナルに表示せず設定する例:

```bash
export MMT_API_URL=http://127.0.0.1:4182
export MMT_PROJECT_ID="<project-uuid>"
read -rsp 'API token: ' MMT_API_TOKEN
export MMT_API_TOKEN
python/.venv/bin/python python/examples/sdk.py
```

tokenには対象projectのmembershipと、使う操作に応じた`read`、`runs:write`、`registry:write`、`artifacts:write`が必要。scopeだけを付けても、別projectへはアクセスできない。

```python
from mado_tracking import Client

with Client() as client:
    with client.start_run(
        project_id="<project-uuid>",
        experiment_id="<experiment-uuid>",
        name="training-v1",
        kind="training",
        parameters={"learning_rate": 0.001},
    ) as run:
        run.log_params({"batch_size": 8})
        run.set_tags({"framework": "pytorch"})
        run.log_metrics({"loss": 0.4}, step=1)
        run.log("checkpoint saved")
        artifact = run.log_artifact("weights.bin", path="model/weights.bin")
        run.register_output_model(
            name="example-model", family="example-family", version="v1",
            artifact_id=artifact["id"],
        )
```

contextが正常に終了するとRunは`finished`、例外が出ると`failed`になる。失敗の報告もAPIに届かなければ、元の例外に報告失敗を添えて呼び出し元へ返す。APIの保存失敗を成功として扱わない。

`create_run()`は`queued`のRunを作る。workerに渡すRunをSDKで`start()`しないこと。workerが供給する`MMT_RUN_ID`があれば、引数なしの`start_run()`でそのRunへ接続する。このcontextの状態はworkerが終了時に確定する。job実行開始後の`log_params()`はAPIに拒否されるため、実行設定はRun作成時に渡す。

`register_model()` / `register_dataset()`は通常の版登録、`register_output_model()` / `register_output_dataset()`はRunの出力登録。出力は`sourceRunId`と親の版IDを保存する。出力モデルは`training` / `finetuning`で登録できる。Artifactはファイルまたはbinary streamからraw bodyで送信し、読み込みを1MiBずつに制限する。

`run.download_input_model("inputs/weights.json")`は、workerが渡したModelVersion metadataをRunの固定された`modelVersionId`とprojectへ照合してから、Artifactをstreamで取得する。ローカルの`file://` URIにも対応する。worker外で使う場合は`model_version=...`に登録済みModelVersionのmetadataを渡す。ダウンロード完了後にファイルを置き換え、通信失敗で部分的な重みを残さない。

## workerを起動する

管理者がproject限定のservice tokenを作る。worker APIには`worker:execute`、実行コードがSDKで記録・登録する場合は前節のscopeも必要。tokenとSSH秘密鍵はworkerマシンに置き、tokenをコードやコマンド引数へ埋め込まない。

```bash
export MMT_API_URL=http://127.0.0.1:4182
export MMT_WORKER_ID=development-worker-1
export MMT_WORKER_TARGET_IDS="<target-uuid>"
export MMT_WORKER_STATE_DIR=/absolute/path/to/private-worker-state
read -rsp 'Worker API token: ' MMT_API_TOKEN
export MMT_API_TOKEN
python/.venv/bin/mado-tracking-worker
```

`MMT_WORKER_ID`とstate directoryは再起動後も同じものを使う。同じdirectoryのworkerを2つ起動すると後の起動を拒否する。`MMT_WORKER_TARGET_IDS`はカンマ区切り。省略した場合は、tokenとAPI設定で許可されたtargetが対象になる。

通常のworkerは`WorkerSettings.parallel_jobs=2`で最大2Jobを並行して監視・実行する。claimには現在監視中のJob IDsを`activeJobIds`として送る。APIは未監視の未完了Jobを同じleaseで返し、全件を監視中なら次のJobをclaimする。targetの`maxConcurrentJobs`とGPU予約による制限も適用される。

SSH targetの`sshKeyPath`と`knownHostsPath`はworkerマシンの既存ファイルを参照する。秘密鍵はmode 600。workerは`StrictHostKeyChecking=yes`、`BatchMode=yes`、`IdentitiesOnly=yes`を指定する。未知のホストキーや変わったホストキーを受け入れない。管理者が別の経路で確認して登録したknown_hostsを使う。

local executorは開発用で、API側のdevelopment設定とworker側の`MMT_ALLOW_LOCAL_EXECUTOR=true`の両方が必要。jobに`gpuIds=[]`を指定すればCPUだけで実行する。`--once`は保持中のjobを回収するか、1件をclaimして終了まで処理する。

compute targetからも`MMT_API_URL`に到達できる必要がある。SSH targetでworkerマシンの`127.0.0.1`を指定しても、そのAPIには接続できない。

## CodeVersionのsourceとargvを固定する

sourceは次の3種類を実行できる。

| source.kind | 内容 | workerの確認 |
|---|---|---|
| `git` | `url`, `commit` | commitは40桁または64桁の完全なhash。fetch後のhashが一致することを確認してdetach checkoutする |
| `inline` | `files: {path: text}` | UTF-8で保存し、絶対パス・`..`・symlinkを拒否する |
| `artifact` | `artifactId` | projectの認証済みcontent APIからstreamで取得。zip/tarのパス、symlink、hardlink、特殊ファイルを検査する |

zip/tarは展開量4GiB、10万entryまで。展開時に既存ファイルを上書きしない。Git sourceのsymlinkも拒否する。CodeVersionの`entrypoint`は`["python", "training.py", "--steps", "40"]`のようなargvを渡す。`python` / `python3` / `{python}` / `${PYTHON}`はjob専用venvのPythonへ置き換える。requirementsにはpipのオプションを渡さず、依存の指定だけを書く。

workerはRun kindとCodeVersionの`taskTypes`、モデル系列、project、pinned version、GPU一覧を確認する。`inference`, `evaluation`, `training`, `finetuning`, `processing`を扱う。`CUDA_VISIBLE_DEVICES`はjobの`gpuIds`を使い、CodeVersionの環境変数より優先する。

## 実行コードはcontextファイルから入力を読む

workerは以下をファイルと環境変数で供給する。ファイルの権限は600。版のIDをそのまま渡し、aliasを実行中に引き直さない。

| 環境変数 | 内容 |
|---|---|
| `MMT_JOB_CONTEXT_FILE` | job/run/project/kind、parameters、ModelVersion、入力DatasetVersions、codeVersionId、GPU一覧のJSON |
| `MMT_PARAMETERS_FILE`, `MMT_PARAMETERS_JSON` | parametersのJSON |
| `MMT_MODEL_VERSION_FILE`, `MMT_MODEL_VERSION_ID` | `{modelVersion: ...}`のJSONとモデル版ID |
| `MMT_DATASET_VERSIONS_FILE`, `MMT_INPUT_DATASET_VERSION_IDS` | `{inputDatasets: [...]}`のJSONと版ID配列のJSON |
| `MMT_API_URL`, `MMT_API_TOKEN` | SDK接続情報 |
| `MMT_PROJECT_ID`, `MMT_EXPERIMENT_ID`, `MMT_RUN_ID`, `MMT_JOB_ID` | 実行対象のID |
| `MMT_JOB_KIND` | 実行するRunのkind。CodeVersionの環境変数より優先する |

対象モデルの重みやdatasetの実体は、コード側がArtifact APIや登録されたURIから読む。workerはmetadataと版参照を渡す。実行コードへ渡す環境変数はhostの基本設定とCodeVersionの設定、SDK設定に限り、workerの無関係なシークレットは継承しない。

## CPUの学習と推論を短時間で試す

APIなしで、線形モデル`y=2x+1`の学習と実際の重み読み込みを確認できる。

```bash
python/.venv/bin/python python/examples/training.py --offline --output python/.venv/example-weights.json
python/.venv/bin/python python/examples/inference.py --offline --weights python/.venv/example-weights.json --output python/.venv/example-predictions.json
```

APIとlocal targetが用意できたら、SDK設定に`MMT_EXAMPLE_TARGET_ID`を加えてジョブを登録する。

```bash
export MMT_EXAMPLE_TARGET_ID="<local-target-uuid>"
python/.venv/bin/python python/examples/register_job.py
export MMT_ALLOW_LOCAL_EXECUTOR=true
python/.venv/bin/mado-tracking-worker --once
```

training例はゼロから初期化してlossを記録し、weights.jsonをArtifactへ保存して出力ModelVersionを登録する。終了後にRunの`outputModelVersionId`タグを取り出し、表示されたinferenceCodeVersionIdとともに新しいinference Runへ指定する。inference例は固定されたモデル版のArtifactから重みを読み、予測結果をArtifactと出力DatasetVersionに保存する。

同じtrainingコードを`kind="finetuning"`のRunで実行すると、入力ModelVersionの`weight`と`bias`から学習を続ける。Runの`modelVersionId`へ固定された入力モデル版を指定する。重みは`MMT_MODEL_FILE`があればそのファイルから、なければSDKの`download_input_model()`で読み込む。familyは`linear`、weight/biasは有限の数値であることを確認し、入力なし・不正な重みは失敗させる。出力ModelVersionには親版IDと、実際に使った初期weight/biasを記録する。kindは接続したRunから判断し、`MMT_JOB_KIND`が指定されている場合は一致も確認する。

APIなしでも、明示した入力ファイルからのfine-tuningを試せる。

```bash
MMT_JOB_KIND=finetuning MMT_MODEL_FILE=python/.venv/example-weights.json \
  python/.venv/bin/python python/examples/training.py --offline --steps 5 --output python/.venv/fine-tuned-weights.json
```

## SSH切断後も同じjobへ復帰する

targetの`workDirectory/<job-id>/`にrunner、SDK、source、venvと実行状態を置く。`start.lock`で同じjobの二重起動を防ぎ、`state.json`にsupervisor/commandのPID、Linux boot IDと起動時刻、exit statusを保存する。stdout/stderrはsecret値を伏せてから専用ファイルへ保存する。tokenやsecretを含むspec.jsonは600で保存し、terminal状態の確定後に削除する。

workerは起動時に`POST /worker/resume`とlocal journalで保持中のjobを回収し、同じleaseをheartbeatで確認して再接続する。ログをAPIが受け付けた位置はjournalへ保存する。起動応答が失われても、同じworkspaceへの再送は既存の実行状態を返す。別workerへの再claimや自動再実行は行わない。

API/SSHの一時障害は指数backoffで再接続する。claimの応答が失われた場合、追加claimより先にresumeで回収する。401/403/404/409/410によるlease拒否では状態変更と新規起動を止める。supervisor消失後にprocessが残っている場合や、PID保存前の起動状態が不明な場合はleaseを維持して再起動を拒否する。状態ファイルを消して再実行しないこと。不明な実行の確認が必要ならcompute target管理者へjob IDとstate.jsonの状態を伝える。

logsとmetricsは少なくとも1回送る方式。APIの保存成功後に応答だけ失われた場合、同じchunkが再送されることがある。completeは同じlease/statusで再送でき、workerも未送信の完了状態をjournalへ保存する。

## ジョブを止めるとprocess groupが終了する

APIの`POST /projects/:p/jobs/:j/cancel`を使う。heartbeatは実行・ログ転送と並行し、cancelRequestedを受け取るとjob workspaceへ停止要求を保存する。runnerは実行中のprocess groupへSIGTERMを送り、10秒以内に終了しなければSIGKILLする。setup中のGit/pipも停止対象。子processも終了してから`canceled`を同じleaseでcompleteする。

entrypointが正常終了した場合も、そのprocess groupに残る子を停止する。子がstdout/stderrを継承していても、pipeのEOFとは別にentrypoint終了を検出し、SIGTERM→同じgrace期限→SIGKILLで後始末する。停止中の出力と残りのログはsecret maskingして回収し、子が実際に停止したことを確認してからJobを完了する。子の停止にSIGKILLが必要でも、entrypointのexit code 0を保持してJobを`finished`でcompleteする。

worker自身のSIGTERM/SIGINTは監視を止め、journalを残す。detachされたjobは実行を続け、同じworkerの再起動で回収する。ジョブの停止は前段のcancel APIで行う。

system metricsはCPU・memoryと、指定GPUの`nvidia-smi`値を採取する。`psutil`が無いtargetではLinuxのmemoryとCPU loadを使う。GPUなしのjobではnvidia-smiを呼ばない。取得できないGPU値を架空の数値で埋めない。

## テストと型検証を実行する

```bash
uv pip install --python python/.venv/bin/python -e 'python[test,telemetry]'
python/.venv/bin/pytest python/tests
python/.venv/bin/mypy --config-file python/pyproject.toml python/src/mado_tracking
python/.venv/bin/ruff check python
```

Pythonのtestsはlocal subprocess、仮HTTP、SSHの仮transportを使う。並列2Job、claim応答喪失後の同一lease復帰、再起動後の二重起動防止、入力重みからのfine-tuningと不正入力の失敗を確認する。

親担当は`scripts/verify_worker.py`で、独立した実API/PostgreSQLとlocal durable workerの結合検証を完了している。対象はCPU training/inference、finetuningの種別と親モデル、cancel/retry/reconnect。結果は`artifacts/verification/2026-10-08/worker-integration.json`。Python testsでは、入力重みからのfine-tuningを別途確認している。実SSH・実GPUには接続していない。結合検証では開発用の独立DB/APIを使い、既存アプリへ接続しない。

用語: Runは実験記録、Jobは実行要求、CodeVersionは不変のsourceと起動設定、leaseはworkerの実行権限、journalは復帰用のlocal記録、workspaceはjob別の実行ディレクトリ。契約の疑問はapi-contract.mdとcontractsを確認し、変更は担当coordinationメモで親担当へ渡す。

更新: 2026-10-08。
