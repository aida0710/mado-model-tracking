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
            model_name="example-model", family="example-family",
            artifact_id=artifact["id"],
        )
```

contextが正常に終了するとRunは`finished`、例外が出ると`failed`になる。失敗の報告もAPIに届かなければ、元の例外に報告失敗を添えて呼び出し元へ返す。APIの保存失敗を成功として扱わない。

`create_run()`は`queued`のRunを作る。workerに渡すRunをSDKで`start()`しないこと。workerが供給する`MMT_RUN_ID`があれば、引数なしの`start_run()`でそのRunへ接続する。このcontextの状態はworkerが終了時に確定する。job実行開始後の`log_params()`はAPIに拒否されるため、実行設定はRun作成時に渡す。

`register_model()` / `register_dataset()`は通常の版登録、`register_output_model()` / `register_output_dataset()`はRunの出力登録。出力は`sourceRunId`と親の版IDを保存する。出力モデルは`training` / `finetuning`で登録できる。

`register_model()` / `register_output_model()`は`model_name=`で既存のModelを名前で探して再利用し、無ければ作成する（`GET /projects/:p/models?name=`で探し、無ければPOST、同時作成で409になったら再GET）。既存Modelのfamilyが`family=`と違う場合は`ConfigurationError`になる。`version`を省略するとAPIが整数で採番する（1, 2, 3, …）。従来の`name=`も同じ動作の別名として受け付ける。出力モデルはRunの`outputModelVersionIds`に登録順で現れ、版を削除すると外れる。sourceRunがtraining/finetuning以外なら422 `output_model_kind`、削除済みRunなら422 `source_run_deleted`になる。Artifactはファイルまたはbinary streamからraw bodyで送信し、読み込みを1MiBずつに制限する。

`run.download_input_model("inputs/weights.json")`は、workerが渡したModelVersion metadataをRunの固定された`modelVersionId`とprojectへ照合してから、Artifactをstreamで取得する。ローカルの`file://` URIにも対応する。worker外で使う場合は`model_version=...`に登録済みModelVersionのmetadataを渡す。ダウンロード完了後にファイルを置き換え、通信失敗で部分的な重みを残さない。

## workerを起動する

管理者がproject限定のservice tokenを作る。workerには`read`、`worker:execute`、実行前のコードを保存するための`artifacts:write`が必要。実行コードがSDKで記録・登録する場合は前節のscopeも付ける。tokenとSSH秘密鍵はworkerマシンに置き、tokenをコードやコマンド引数へ埋め込まない。

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

## CodeVersionのruntimeとargvを固定する

SDK/workerとcompute targetのsupervisorにはLinuxとPython 3.11以上が必要。コンテナ内の言語やSDKの有無はimage側で決める。`ComputeTarget.runtimeKinds`に実行するruntimeを登録し、CLIとdaemonをそのtarget上へ用意する。既存の登録入力は`runtime`省略時にPython、targetの`runtimeKinds`省略時は`["python"]`になる。

| runtime.kind | 固定する実体 | sourceと依存関係 |
|---|---|---|
| `python` | Git commit / inline / code Artifact | source必須。従来のjob専用venvとrequirementsを使う |
| `docker` | `registry/repository@sha256:<64桁hex>` | sourceはnullまたは任意。requirementsは空。image内へ必要な依存を入れる |
| `singularity`, `apptainer` | 保存済みArtifactの`artifactId`と`sha256` | SIFを取得してSHA256を照合する。sourceはnullまたは任意。requirementsは空 |

コンテナの`entrypoint`は必須argvで、imageのENTRYPOINTやSIFのrunscriptを上書きする。`python`などの置換はPython runtimeだけに適用する。コンテナにはvenv作成やpip installを行わない。

```python
code = client.register_code(
    project_id, name="container inference", version="v1",
    source=None,
    runtime={"kind": "docker", "image": "registry/model@sha256:<64桁hex>", "workingDirectory": "/app"},
    entrypoint=["python", "/app/inference.py"],
    supported_model_families=["linear"], task_types=["inference", "evaluation"],
)
```

`workingDirectory`はコンテナ内の絶対パス。指定があればそれを使う。省略時はsource付きコンテナでは`/mmt/source`、sourceなしDockerではimageのWORKDIRを使う。sourceなしSIFではruntimeの既定cwdを使うため、再現性が必要なら明示する。

Dockerはtargetと同じLinuxホスト上のUnix socket daemonを使う。targetの実行ユーザーがdaemonへアクセスでき、同じユーザーのUID:GIDでbind mountを読み書きできる構成が前提。read-only bindは再帰的に指定するため、対応CLIとLinux kernel 5.12以上が必要。Docker 29.1.3のlocal daemonで確認した。rootless/user namespace remappingは未検証。[Dockerのbind mount仕様](https://docs.docker.com/engine/storage/bind-mounts/)

SDKからtarget側のAPIへ到達するため、Dockerは`--network host`で起動する。API URLの`127.0.0.1`はcompute target自身を指す。SSH先からworkerマシンのloopbackへは接続できない。Linuxのhost networkingではport mappingを使わない。[Dockerのhost network仕様](https://docs.docker.com/engine/network/drivers/host/)

DockerのGPUは`--gpus device=...`でJobに予約されたIDだけを指定し、CUDAの番号はコンテナ内の`0..N-1`にする。CPU JobはGPUを渡さない。GPU実行にはtargetのNVIDIA driverとNVIDIA Container Toolkitが必要。SIFは`--nv`と`CUDA_VISIBLE_DEVICES`を使い、hostのGPU IDを保持する。SIFの`--nv`はdevice自体の分離ではなくCUDAの可視性を制限する方式。実GPUでの検証は未実施。[ApptainerのGPU選択](https://apptainer.org/docs/user/latest/gpu.html)

SIF CLIには`exec`の`--cleanenv`, `--containall`, `--no-home`, `--no-mount`, `--no-eval`, `--pwd`が必要。起動前に対応を確認する。envは`APPTAINERENV_`または`SINGULARITYENV_`で渡し、shell評価とhostのhome/cwd/設定済みbindを無効にする。対応CLIが無い場合は`state.runtimeCapability.available=false`と理由を返し、Jobを失敗にする。[Apptainer exec](https://apptainer.org/docs/user/latest/cli/apptainer_exec.html)、[Singularity exec](https://docs.sylabs.io/guides/latest/user-guide/cli/singularity_exec.html)

## 任意sourceは保存した版から展開する

sourceは次の3種類を実行できる。

| source.kind | 内容 | workerの確認 |
|---|---|---|
| `git` | `url`, `commit`, `files?`, `deletedFiles?` | 完全なhashを照合してdetach checkoutし、編集ファイルと削除パスを反映する |
| `inline` | `files: {path: text}` | UTF-8で保存し、絶対パス・`..`・symlinkを拒否する |
| `artifact` | `artifactId` | projectの認証済みcontent APIからstreamで取得。zip/tarのパス、symlink、hardlink、特殊ファイルを検査する |

zip/tarは展開量4GiB、10万entryまで。展開時に既存ファイルを上書きしない。Git sourceのsymlinkも拒否する。CodeVersionの`entrypoint`は`["python", "training.py", "--steps", "40"]`のようなargvを渡す。`python` / `python3` / `{python}` / `${PYTHON}`はjob専用venvのPythonへ置き換える。requirementsにはpipのオプションを渡さず、依存の指定だけを書く。

workerはRun kindとCodeVersionの`taskTypes`、モデル系列、project、pinned version、GPU一覧を確認する。`inference`, `evaluation`, `training`, `finetuning`, `processing`を扱う。`CUDA_VISIBLE_DEVICES`はjobの`gpuIds`を使い、CodeVersionの環境変数より優先する。

Runの`executionSnapshot`とコード版を照合し、`executionMode=test`では保存済みの`testEntrypoint`を使う。実行前に`.mmt/source.zip`と`.mmt/source-manifest.json`を作成し、終了時にRunのArtifactsへ保存する。manifestにはRun・Job・コード版・commit・コマンドとファイルのhashを記録し、環境変数の値は含めない。sourceなしコンテナはmanifestだけを保存する。再接続時は作成済みのsnapshotを回収し、コードを再展開しない。

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

Python runtimeでは、モデル重みやdatasetの実体をコード側がArtifact APIや登録URIから読む。コンテナでは、workerが重みを実行前に取得する。DatasetVersionはどちらもmetadataとURIを渡す方式。実行コードへ渡す環境変数はCodeVersionの設定とSDK設定に限り、workerの無関係なシークレットは継承しない。

## コンテナの入力と出力は標準pathを使う

コンテナへ渡すmountは次のディレクトリに限定する。spec/state、API tokenのファイル、SSH設定、workerのhomeはmountしない。SDK接続用envは優先して供給し、Dockerはprivateなenv-file、SIFはprefix付きenvで渡す。secret値はargvへ含めない。

| コンテナ内path | 内容 | mount |
|---|---|---|
| `/mmt/inputs/weights` | 入力ModelVersionのprimary weights file | read-only |
| `/mmt/context` | context、parameters、model-version、dataset-versionsのJSON | read-only |
| `/mmt/source` | 任意sourceの固定版。source=nullならmountしない | read-only |
| `/mmt/outputs` | imageが生成する結果 | read/write |

Artifact重みはworkerが認証済みAPIからstream取得し、targetへの転送後もSHA256とサイズを確認する。SIFも登録SHA256と実ファイルを照合する。途中でdownload/転送が失敗した入力からentrypointを起動しない。`file://`の重みはtarget側のregular fileからcopyする。HTTP(S)の重みはworker側の別clientで取得し、API tokenやCookieを転送せず、redirectを追わない。Datasetの外部URIにはworkerからアクセスしない。

重みとArtifactのdownloadは、HTTPの`Content-Length`を圧縮された転送bodyのbytes数と照合する。保存ファイルのサイズとSHA256は展開後のbytesから計算する。`Content-Encoding`はidentity・gzip・deflateに対応し、gzip/deflateの末尾欠落やchecksum破損も拒否する。

既存のcontext用envはコンテナ内のpathへ差し替える。追加envは`MMT_MODEL_FILE=/mmt/inputs/weights`、`MMT_INPUTS_DIR=/mmt/inputs`、`MMT_OUTPUTS_DIR=/mmt/outputs`、`MMT_RESULT_FILE=/mmt/outputs/result.json`。入力モデルが無い場合の`MMT_MODEL_FILE`は空。任意sourceのpathは`MMT_SOURCE_DIR`で渡す。

SDKをimage内に入れた場合は従来のAPIを使える。SDKなしimageは、出力ファイルを閉じてchecksumを確定してから、最後に`result.json`をatomic renameで保存する。

```json
{
  "version": 1,
  "complete": true,
  "artifacts": [
    {"path": "predictions.json", "sha256": "<64桁hex>", "size": 18, "mimeType": "application/json"}
  ],
  "metrics": [{"name": "accuracy", "value": 0.9, "step": 0}]
}
```

`path`はoutputs内の相対パス、`size`はbyte数。metricsは有限の数値で、`step`は非負の整数。省略したstepは0、timestampは回収時のUTC時刻になる。宣言した全fileのSHA256/size、未宣言file、symlink/hardlink/特殊file、絶対パスや`..`、`.partial`/`.tmp`を検査する。結果は128 files、1000 metrics、manifestは1MiBまで。出力ディレクトリが空ならmanifestは不要。

entrypointが成功し、daemon/processが停止した後だけ結果を回収する。workerはfileを再びstream取得してSHA256を確認し、Run Artifactの`container/<path>`へ保存する。metricsはlease付きworker APIへ送り、全保存を確認してからJobをcompleteする。結果検証やAPIの永久失敗はJobをfailedにする。cancel/nonzero exitの出力を成功結果として登録しない。ModelVersion/DatasetVersionの登録はSDKまたはAPIで明示する。

各fileとmetricsの保存成功はjournalへ残す。復帰時は未保存項目から再開する。APIが保存した後に応答が失われた場合は再送され得るため、Artifactを含めて少なくとも1回送る方式になる。

## モデル登録後の自動推論・評価をSDKで設定する

Project管理者は、固定CodeVersion、Experiment、Target、入力DatasetVersionsを指定してruleを作る。管理操作にはtokenの`admin` scopeも必要。設定の変更は新しいruleを作り、有効/無効だけを切り替える。

```python
rule = client.create_automation_rule(
    project_id, name="evaluate linear models", model_families=["linear"], kind="evaluation",
    experiment_id=experiment_id, code_version_id=code["id"], target_id=target_id,
    input_dataset_version_ids=[dataset_version_id], parameters={"batch_size": 8},
)
client.set_automation_rule_enabled(project_id, rule["id"], enabled=False)
rules = client.list_automation_rules(project_id)
executions = client.list_automation_executions(project_id)
```

有効ruleは、その後に保存が確定したModelVersionから起動する。過去の版は対象外。同じruleとモデル版の組合せは一度だけqueueへ入る。`register_output_model()`もこの登録経路を使う。rule自体の受付状態と、作られたRun/Jobの実行状態は`automation-executions`で確認する。

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

training例はゼロから初期化してlossを記録し、weights.jsonをArtifactへ保存して、固定のModel `cpu-linear`に自動採番で出力ModelVersionを足す。終了後にRunの`outputModelVersionIds`から版IDを取り出し、表示されたinferenceCodeVersionIdとともに新しいinference Runへ指定する。inference例は固定されたモデル版のArtifactから重みを読み、予測結果をArtifactと出力DatasetVersionに保存する。

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

DockerはJob IDに対応するcontainer名と、Job/CodeVersion/project/lease/workspaceのlabelを保存する。復帰時はlabel、固定image、container IDを照合して既存containerへattachし、`docker start`を再送しない。supervisorが消失しても、監視専用supervisorを復旧して同じcontainerを回収する。未起動containerを再実行することはない。[Docker create/startの仕様](https://docs.docker.com/reference/cli/docker/container/create/)

取消やログclientの失敗では、daemon側をSIGTERM→grace期限で停止し、containerの削除と不在を確認する。entrypointの終了時も残るprocessをdaemon側で片付ける。`docker logs`などのclientをkillしただけでは完了しない。daemonへ接続できない、または所有を照合できない間はleaseとGPU予約を維持する。supervisor復旧時はDockerログが再送される場合がある。SIFは記録したboot ID・PID起動時刻・session/process groupを照合し、子の停止を確認する。

Dockerのログthreadを作成・開始できない場合やjoinが失敗した場合も、所有containerの停止・削除と不在確認を行う。`unknown`状態は、supervisor・process group・起動途中のprocess・未解放containerのいずれかが残る可能性があれば完了しない。supervisor生存中の`unknown`や、生存情報が欠けた応答でもleaseとGPU予約を保持する。既存Python実行は、supervisorとprocess groupが消失し、起動途中でもないことを確認できた場合にfailed完了する。

system metricsはCPU・memoryと、指定GPUの`nvidia-smi`値を採取する。`psutil`が無いtargetではLinuxのmemoryとCPU loadを使う。GPUなしのjobではnvidia-smiを呼ばない。取得できないGPU値を架空の数値で埋めない。

## テストと型検証を実行する

```bash
uv pip install --python python/.venv/bin/python -e 'python[test,telemetry]'
python/.venv/bin/pytest python/tests
python/.venv/bin/mypy --config-file python/pyproject.toml python/src/mado_tracking
python/.venv/bin/ruff check python
python/.venv/bin/ruff format --check python
uv build --python python/.venv/bin/python --out-dir python/dist python
```

Pythonのtestsはlocal subprocess、仮HTTP、SSHの仮transportを使う。並列2Job、claim応答喪失後の同一lease復帰、再起動後の二重起動防止、入力重みからのfine-tuningと不正入力の失敗を確認する。

Dockerの挙動テストはcached digest imageを明示して実行する。SDKなしfixtureの`python/examples/container_fixture.py`はAlpine/BusyBoxで動き、read-only入力、結果file、metrics、token maskingを確認する。`MMT_EXAMPLE_DOCKER_IMAGE`を指定すれば、実API用のCodeVersionも登録できる。

```bash
MMT_TEST_DOCKER_IMAGE='alpine@sha256:<cached digest>' python/.venv/bin/pytest python/tests/test_docker_worker.py
```

Docker testsでは成功/失敗、出力検証/API保存失敗、daemon取消、worker/supervisorの復帰、失われた起動応答を確認する。SIFはCLI fixtureと実process groupでSHA、GPU選択env、取消、secret masking、出力回収を検証する。実SIF image、実SSH、GPU driver/Toolkitを含む結合は未確認。wheelから作ったremote zipappにも各runtime moduleを含める。

親担当は`scripts/verify_worker.py`で、独立した実API/PostgreSQLとlocal durable workerの結合検証を完了している。対象はCPU training/inference、finetuningの種別と親モデル、cancel/retry/reconnect。結果は`artifacts/verification/2026-10-08/worker-integration.json`。Python testsでは、入力重みからのfine-tuningを別途確認している。実SSH・実GPUには接続していない。結合検証では開発用の独立DB/APIを使い、既存アプリへ接続しない。

用語: Runは実験記録、Jobは実行要求、CodeVersionは不変のsourceと起動設定、leaseはworkerの実行権限、journalは復帰用のlocal記録、workspaceはjob別の実行ディレクトリ。契約の疑問はapi-contract.mdとcontractsを確認し、変更は担当coordinationメモで親担当へ渡す。

更新: 2026-10-08。
