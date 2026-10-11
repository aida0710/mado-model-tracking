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

Pythonのバージョンが3.11未満なら、対応するPythonを別途用意する。リポジトリのrootから、専用venvにSDKとworkerを入れる。

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

`register_model()` / `register_dataset()`は通常のバージョン登録、`register_output_model()` / `register_output_dataset()`はRunの出力登録。出力は`sourceRunId`と親のバージョンIDを保存する。出力モデルは`training` / `finetuning`で登録できる。

`register_model()` / `register_output_model()`は`model_name=`で既存のModelを名前で探して再利用し、無ければ作成する（`GET /projects/:p/models?name=`で探し、無ければPOST、同時作成で409になったら再GET）。既存Modelのfamilyが`family=`と違う場合は`ConfigurationError`になる。`version`を省略するとAPIが整数で採番する（1, 2, 3, …）。従来の`name=`も同じ動作の別名として受け付ける。出力モデルはRunの`outputModelVersionIds`に登録順で現れ、バージョンを削除すると外れる。sourceRunがtraining/finetuning以外なら422 `output_model_kind`、削除済みRunなら422 `source_run_deleted`になる。Artifactはファイルまたはbinary streamからraw bodyで送信し、読み込みを1MiBずつに制限する。64MiB以上のファイルは次節のupload sessionで送る。

`run.download_input_model("inputs/weights.json")`は、workerが渡したModelVersion metadataをRunの固定された`modelVersionId`とprojectへ照合してから、Artifactをstreamで取得する。途中で接続が切れたら、受信済みのbyte位置からRangeで再開する（後述）。ローカルの`file://` URIにも対応する。worker外で使う場合は`model_version=...`に登録済みModelVersionのmetadataを渡す。ダウンロード完了後にファイルを置き換え、通信失敗で部分的な重みを残さない。

### 大きなArtifactは再開可能なupload sessionで送る

`run.log_artifact(path)`は、ファイルが`SESSION_UPLOAD_THRESHOLD_BYTES`（64MiB）以上なら`POST /projects/:p/artifact-uploads`のupload sessionで送る。64MiB未満のファイルとbinary streamは従来どおり1回のPUTで送る。`run.log_artifacts(directory, path="results")`はディレクトリ以下の全ファイルを相対pathのまま送り、ファイルごとに同じ基準で方式を選ぶ。symlinkのディレクトリには入らない。

- 送る前にファイル全体と各partのSHA-256を計算し、sessionの`expectedSha256`と各partの`X-Part-SHA256`に入れる。partは既定16MiBで、part数が10000を超えるファイルではpartを大きくする。
- partは4本並列で送り、partごとに通信失敗と5xxを再試行する。
- sessionのidを`~/.cache/mado-tracking/uploads/<sha256>.json`（`XDG_CACHE_HOME`があればその下。mode 600）に残す。tokenは書かない。同じファイルを同じRun・pathへ送り直すと、APIの`receivedParts`と照合し、SHA-256が一致するpartは送らない。接続先・Run・path・part sizeのどれかが違う、またはsessionが期限切れ・abort・別の認証情報のものなら、新しいsessionを作る。
- 全partを送ったらcompleteし、APIの検証（`verifying`→`completed`）を待ってから登録済みArtifactを返す。全体のSHA-256が合わず`failed`になった場合は`UploadSessionFailed`を投げ、状態ファイルを消す。送信中にファイルが変わったときも状態ファイルを消して`ConfigurationError`にする。
- worker processが途中で止まった場合も、同じファイルで`log_artifact`を呼び直せば続きから送る。

### Artifactのdownloadは切断後にRangeで再開する

`client.download_artifact_to(project_id, artifact_id, stream)`は、seek可能なstreamへArtifactを書き、`{sha256, size}`を返す。`Accept-Encoding: identity`で取得し、接続が切れたら`Range: bytes=<受信済み>-`と`If-Range: <ETag>`で続きを要求する。content endpointのETagは`"sha256-<hex>"`でバージョンを表す。途中でバージョンが変わってAPIが200で全体を返した場合は、受信済みのbytesを捨てて最初から書き直す。最後に全体のSHA-256をETagと照合する。最初の要求がHTTPエラーになった場合は再試行せず、そのまま`ApiError`にする。再開は最大6回まで。`client.download_artifact()`のiteratorは従来どおり再開しない。

## workerを起動する

worker tokenは、Projectの設定画面「Service Accounts」で作ったService Account（Role `Admin`）に発行する。scopeは`read`、`worker:execute`、実行前のコードと出力ファイル（`/mmt/outputs`・`MMT_OUTPUTS_DIR`）をRun Artifactへ保存するための`artifacts:write`。`result.json`で出力モデル・出力Datasetを宣言して登録するなら`registry:write`も要る。出力のmetricsはworker APIで送るため、ほかのscopeは要らない。実行コードの記録・登録にはworker tokenを使わない（次節）ので、そのためにscopeを足す必要もない。個人が所有するservice token（`POST /tokens`のkind=`service`）は旧形式で、所有者がProjectを離れると止まる。期限は最長365日（`MMT_TOKEN_MAX_LIFETIME_DAYS`）で、期限が近づいたら新しいtokenを発行して`mado-tracking-worker install --token-file`で差し替える。手順は[operations.md](operations.md)の「1. tokenを用意する」。tokenとSSH秘密鍵はworkerマシンに置き、tokenをコードやコマンド引数へ埋め込まない。

```bash
export MMT_API_URL=http://127.0.0.1:4182
export MMT_WORKER_ID=development-worker-1
export MMT_WORKER_TARGET_IDS="<target-uuid>"
export MMT_WORKER_STATE_DIR=/absolute/path/to/private-worker-state
read -rsp 'Worker API token: ' MMT_API_TOKEN
export MMT_API_TOKEN
python/.venv/bin/mado-tracking-worker
```

常駐させる場合は、手動の `export` と `read -rsp` の代わりに `mado-tracking-worker install`（systemd user/system unit）を使う。手順は [operations.md](operations.md) の「workerホストへworkerを導入する」。`install`・`upgrade`・`status`・`doctor` のサブコマンドが増えたが、引数なしと `--once` は従来どおりworkerの実行（`run`）になる。containerでは `MMT_API_TOKEN_FILE` に置いたtoken fileを `MMT_API_TOKEN` として読む（`MMT_API_TOKEN` が既にあればそちらを使う）。

出力ファイル数の上限は`MMT_WORKER_MAX_OUTPUT_FILES`（既定10000、1〜1000000）で変えられる。詳しくは下の「コンテナの入力と出力は標準pathを使う」。

`MMT_WORKER_ID`とstate directoryは再起動後も同じものを使う。同じdirectoryのworkerを2つ起動すると後の起動を拒否する。`MMT_WORKER_TARGET_IDS`はカンマ区切り。省略した場合は、tokenとAPI設定で許可されたtargetが対象になる。ただし、targetの接続確認（下の「Compute targetの接続を確認する」）は`MMT_WORKER_TARGET_IDS`にそのtargetを含むworkerだけがclaimする。

通常のworkerは`WorkerSettings.parallel_jobs=2`で最大2Jobを並行して監視・実行する。claimには現在監視中のJob IDsを`activeJobIds`として送る。APIは未監視の未完了Jobを同じleaseで返し、全件を監視中なら次のJobをclaimする。targetの`maxConcurrentJobs`とGPU予約による制限も適用される。

SSH targetの`sshKeyPath`と`knownHostsPath`はworkerマシンの既存ファイルを参照する。秘密鍵はmode 600。workerは`StrictHostKeyChecking=yes`、`BatchMode=yes`、`IdentitiesOnly=yes`を指定する。未知のホストキーや変わったホストキーを受け入れない。管理者が別の経路で確認して登録したknown_hostsを使う。

local executorは開発用で、API側のdevelopment設定とworker側の`MMT_ALLOW_LOCAL_EXECUTOR=true`の両方が必要。jobに`gpuIds=[]`を指定すればCPUだけで実行する。`--once`は保持中のjobを回収するか、1件をclaimして終了まで処理する。

compute targetからも`MMT_API_URL`に到達できる必要がある。SSH targetでworkerマシンの`127.0.0.1`を指定しても、そのAPIには接続できない。

## 実行コードにはJob限定tokenを渡す

実行コードの`MMT_API_TOKEN`と`MLFLOW_TRACKING_TOKEN`には、APIがJobごとに発行するJob限定token（`mmtj_`で始まる）が入る。worker自身のtokenは実行コードの環境変数に入らない。

- 権限はRunの作成者のもの。scopeは`read`・`runs:write`・`artifacts:write`・`registry:write`で、Project権限は作成者の現在のmembershipで決まる（editorが投入したコードはeditorの権限で動く。作成者をProjectから外すと403）。
- 書けるのは対象Run（metrics・params・tags・logs・入力Dataset・Artifact）、そのRunをsourceとするモデル・データセットのバージョン、そのRunのLogged Model、出力先Modelの作成だけ。同じProjectの別Run、worker API、token発行、Project設定、自動実行rule、Runの説明文とコメントは403。読み出しは同じProject内なら可能（上流RunのArtifact取得など）。
- Jobが終わる（成功・失敗・cancel）かleaseが変わると401になる。
- tokenはworkerのstate directory（mode 700、ファイルは600）のjournalに保存し、worker再起動後の実行中Jobはその値を使い続ける。state directoryを失った場合、実行中Jobの新しい起動はしない。
- workerは実行開始の直後に`running`のheartbeatを送る。`claimed`のままworkerが再起動するとAPIはtokenを再発行するため、実行中processのtokenが失効しないようにする。
- claimが一時的に失敗するとworkerはresumeで回復し、準備中（`claimed`）のJobのtokenはそのとき再発行される。workerは実行コードを起動する直前に新しいtokenへ切り替える。

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

## 任意sourceは保存したバージョンから展開する

sourceは次の3種類を実行できる。

| source.kind | 内容 | workerの確認 |
|---|---|---|
| `git` | `url`, `commit`, `files?`, `deletedFiles?` | 完全なhashを照合してdetach checkoutし、編集ファイルと削除パスを反映する |
| `inline` | `files: {path: text}` | UTF-8で保存し、絶対パス・`..`・symlinkを拒否する |
| `artifact` | `artifactId` | projectの認証済みcontent APIからstreamで取得。zip/tarのパス、symlink、hardlink、特殊ファイルを検査する |

zip/tarは展開量4GiB、10万entryまで。展開時に既存ファイルを上書きしない。Git sourceのsymlinkも拒否する。CodeVersionの`entrypoint`は`["python", "training.py", "--steps", "40"]`のようなargvを渡す。`python` / `python3` / `{python}` / `${PYTHON}`はjob専用venvのPythonへ置き換える。requirementsにはpipのオプションを渡さず、依存の指定だけを書く。

workerはRun kindとCodeVersionの`taskTypes`、モデル系列、project、pinned version、GPU一覧を確認する。`inference`, `evaluation`, `training`, `finetuning`, `processing`を扱う。`CUDA_VISIBLE_DEVICES`はjobの`gpuIds`を使い、CodeVersionの環境変数より優先する。

Runの`executionSnapshot`とコードバージョンを照合し、`executionMode=test`では保存済みの`testEntrypoint`を使う。実行前に`.mmt/source.zip`と`.mmt/source-manifest.json`を作成し、終了時にRunのArtifactsへ保存する。manifestにはRun・Job・コードバージョン・commit・コマンドとファイルのhashを記録し、環境変数の値は含めない。sourceなしコンテナはmanifestだけを保存する。再接続時は作成済みのsnapshotを回収し、コードを再展開しない。

## 実行コードはcontextファイルから入力を読む

workerは以下をファイルと環境変数で供給する。ファイルの権限は600。バージョンのIDをそのまま渡し、aliasを実行中に引き直さない。

| 環境変数 | 内容 |
|---|---|
| `MMT_JOB_CONTEXT_FILE` | job/run/project/kind、parameters、ModelVersion、入力DatasetVersions、codeVersionId、GPU一覧のJSON |
| `MMT_PARAMETERS_FILE`, `MMT_PARAMETERS_JSON` | parametersのJSON |
| `MMT_MODEL_VERSION_FILE`, `MMT_MODEL_VERSION_ID` | `{modelVersion: ...}`のJSONとモデルバージョンID |
| `MMT_DATASET_VERSIONS_FILE`, `MMT_INPUT_DATASET_VERSION_IDS` | `{inputDatasets: [...]}`のJSONとバージョンID配列のJSON |
| `MMT_INPUT_DATASET_DIRS` | 入力DatasetVersionの本体を置いたディレクトリ`{versionId: path}`のJSON（read-only）。記述子だけのバージョン（`urn:`・`mmt-artifact:`）は入らない（「入力Datasetの本体はworkerが実行前に用意する」節） |
| `MMT_UPSTREAM_RUN_ID`, `MMT_UPSTREAM_RUN_FILE` | 上流Run（`run.parentRunId`）のIDと`upstream-run.json`のpath。上流が無いJobには付かない |
| `MMT_RESUME_CHECKPOINT_DIR`, `MMT_RESUME_STEP`, `MMT_RESUME_CHECKPOINT_FILE` | 再開元checkpointの展開先（read-only）、保存時のstep、`resume-checkpoint.json`のpath。checkpointから再開しないJobには付かない（「学習を途中から再開する」節） |
| `MMT_API_URL`, `MMT_API_TOKEN` | SDK接続情報。tokenはJob限定token |
| `MMT_PROJECT_ID`, `MMT_EXPERIMENT_ID`, `MMT_RUN_ID`, `MMT_JOB_ID` | 実行対象のID |
| `MMT_JOB_KIND` | 実行するRunのkind。CodeVersionの環境変数より優先する |
| `MMT_OUTPUTS_DIR`, `MMT_RESULT_FILE` | 出力ディレクトリ（workspaceの`outputs`）と`result.json`のpath。コンテナと同じ形式で回収する |

Python runtimeでも、SDKを使わずに`MMT_OUTPUTS_DIR`へファイルと`result.json`を書けば、コンテナと同じ検証で回収してRun Artifactの`container/<path>`へ保存する（形式と上限は次節）。何も書かなければ従来どおり回収しない。ファイルがあるのに`result.json`が無い、または宣言と合わない場合はJobをfailedにする。

Python runtimeでは、モデル重みの実体をコード側がArtifact APIや登録URIから読む。コンテナでは、workerが重みを実行前に取得する。入力DatasetVersionの本体は、どのruntimeでもworkerが実行前にtargetへ用意し、`MMT_INPUT_DATASET_DIRS`で場所を渡す。実行コードへ渡す環境変数はCodeVersionの設定とSDK設定に限り、workerの無関係なシークレットは継承しない。

### 上流RunのArtifactsを取得する

自動実行の連鎖で起動した評価Jobは、上流（推論）Runの出力を`MMT_UPSTREAM_RUN_ID`で知る。`upstream-run.json`は`{runId, outputDatasetVersionIds?, outputModelVersionIds?}`で、WorkerJobから分かる項目だけを書く（上流のkindは入らない）。host pythonではworkspace直下、コンテナでは`/mmt/context/upstream-run.json`に置く。DatasetVersionの記述子は従来どおり`dataset-versions.json`に入る。

上流RunのArtifacts（生成したWAVや予測jsonlなど）は、SDKでpath構成を保ったまま取得できる。Job限定tokenはProject内のRunを読める。

```python
from mado_tracking import download_upstream_artifacts, upstream_run_id

if upstream_run_id() is not None:
    wavs = download_upstream_artifacts("upstream", prefix="wav/")  # upstream/wav/... に保存
```

上流が無いJobでは`upstream_run_id()`はNone、2つの関数は空の配列を返し、APIを呼ばない。同じpathに複数のバージョンがあれば最新のバージョンを取る。`..`や絶対パスを含むArtifact pathがあれば、何も書かずに`ConfigurationError`にする。保存は一時ファイルからのrenameなので、途中で失敗しても壊れたファイルは残らない。Rangeでの再開は未対応（全体を取り直す）。

## 入力Datasetの本体はworkerが実行前に用意する

workerは実行コードを起動する前に、入力DatasetVersionごとに本体をtargetへ用意して照合する。用意できなければentrypointを起動せずJobを`failed`で完了する（APIがGPU予約を解放する）。理由はRunのログにerrorで残り、`Job.error`にも入る。

| バージョン | 取得元 | 照合 |
|---|---|---|
| `contentKind=artifacts` | files API（`GET /projects/:p/datasets/:d/versions/:v/files`）の一覧のArtifact | 一覧からmanifest digestを計算し直してバージョンの`digest`と一致させ、各ファイルのsha256・sizeを照合する |
| `reference`の`file://` | target上の既存path。copyしない | 存在と読み取り権限だけ確かめる |
| `reference`の`https://` | 認証無しのGET。redirectは追わない。保存名はURLの最後のpath区間 | `digest`が`sha256:<hex>`か64桁hexならsha256を照合する。それ以外の形のdigestは照合できない |
| `reference`の`s3://bucket/key` | target上の`AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY`・`AWS_SESSION_TOKEN`・`AWS_REGION`（無ければ`us-east-1`）・`AWS_ENDPOINT_URL_S3`/`AWS_ENDPOINT_URL`・`AWS_CA_BUNDLE`で署名v4。keyがobjectそのものならその1つ、それ以外は`key/`配下の全object | sizeを照合する（S3のETagはsha256ではない） |
| `reference`の`urn:`・`mmt-artifact:` | 取得しない（記述子だけ。上流RunのArtifactはSDKで読む） | Runのログにinfoで残す |
| それ以外のscheme（`gs:`、`hf:`、schemeなしのpathなど） | 取得できないのでJobを開始前に失敗させる | — |

`contentKind`を持たない記述子（第4波より前のAPI）は従来どおり取得しない。

### 転送方式（targetの`datasetTransfer`）

- `relay`（既定）: workerがworker tokenでAPIからArtifactを取得し（Range再開・sha256照合）、HTTPSも取得して、1本のtarでtargetへ送る。GPUコンピュータがAPIへ届かなくてよい。worker側の一時ファイルはstate directory配下のjournalに置き、送信後に消す（worker側にも一時的にバージョン1つ分の空きが要る）。
- `direct`: targetがJob token（`mmtj_`）で`GET /projects/:p/artifacts/:a/content`を呼ぶ。HTTPSもtargetが取得する。worker tokenはtargetへ渡さない。Job tokenはrunnerのstdinで渡し（worker側では権限600の一時ファイルを経由して送信後に消す）、argvやtarget上のファイルに残さない。targetから`MMT_API_URL`（workerのAPI URL）へ届く必要がある。
- `s3://`と`file://`は方式によらずtarget側で扱う。S3の認証情報はtargetのSSH非対話シェル（local executorならworker process）の環境変数に置く。APIやworkerには置かない。

target側の取得がネットワークやサーバー側の理由で失敗したら、2秒・4秒あけて最大3回まで試す。404・照合の不一致・上限超過はすぐ失敗にする。

### dataset cache

本体は`<workDirectory>/.mmt-cache/datasets/<key>/data`に置く。`<key>`は`artifacts`のバージョンではmanifest digestのhex、`reference`のバージョンでは`r-`＋`sha256(uri + "\n" + digest)`。

- 同じkeyは`<key>.lock`（flock）で排他する。完了マーカー`complete.json`があればそのまま使い、取得し直さない。同じworkerの並列Jobはworker内でも待ち合わせるので、`relay`でも取得は1回。別のworkerのJobとはtargetのlockで待ち合わせる（`relay`ではそれぞれのworkerが一度取得し、後に着いた方のtarは使わずに捨てる）。
- 完了マーカーの無いentry（取得中に中断したもの）は信用せず、消して作り直す。
- 完了したファイルはread-only（ファイル0400、ディレクトリ0500）。host pythonはworkspaceの`inputs/datasets/<versionId>`（cacheへのsymlink）、Docker・Singularity・Apptainerは`/mmt/datasets/<versionId>`（read-only bind）で読む。起動直前にもう一度完了マーカーを確かめる。
- 上限はtargetの`datasetCacheMaxBytes`（既定100GiB、全体設定の「コンピュータ」のtarget編集で、所有者か全体管理者が変えられる）。新しいentryを入れる前に、最終使用（`last-used`のmtime）の古い順に消す。未終了のJobが使うentry（`users/<jobId>`のworkspaceが終端でない）は消さない。使用中のentryだけで上限を超えるときは、そのまま取得してRunのログに残す。1つのバージョンが上限より大きければJobを失敗させる。
- 起動前に失敗・取消したJobは自分の使用印を外す。外せずに残った使用印は、workspaceが24時間起動しなければ無効になる。

`MMT_DATASET_VERSIONS_FILE`・`MMT_INPUT_DATASET_VERSION_IDS`と、上流Runの`MMT_UPSTREAM_RUN_ID`・`upstream-run.json`は従来どおり渡すので、記述子やSDKで読むコードはそのまま動く。

```python
import json, os, pathlib

for version_id, directory in json.loads(os.environ.get("MMT_INPUT_DATASET_DIRS", "{}")).items():
    for wav in sorted(pathlib.Path(directory).rglob("*.wav")):
        ...
```

worker tokenには`read` scopeが要る（files APIを読むため）。

## コンテナの入力と出力は標準pathを使う

コンテナへ渡すmountは次のディレクトリに限定する。spec/state、API tokenのファイル、SSH設定、workerのhomeはmountしない。SDK接続用envは優先して供給し、Dockerはprivateなenv-file、SIFはprefix付きenvで渡す。secret値はargvへ含めない。

| コンテナ内path | 内容 | mount |
|---|---|---|
| `/mmt/inputs/weights` | 入力ModelVersionのprimary weights file | read-only |
| `/mmt/inputs/checkpoint` | 再開元checkpointのファイル（再開するJobだけ） | read-only |
| `/mmt/datasets/<versionId>` | 入力DatasetVersionの本体（targetのdataset cacheか`file://`のpath） | read-only |
| `/mmt/context` | context、parameters、model-version、dataset-versionsのJSON | read-only |
| `/mmt/source` | 任意sourceの固定バージョン。source=nullならmountしない | read-only |
| `/mmt/outputs` | imageが生成する結果 | read/write |

Artifact重みはworkerが認証済みAPIからstream取得し、targetへの転送後もSHA256とサイズを確認する。SIFも登録SHA256と実ファイルを照合する。途中でdownload/転送が失敗した入力からentrypointを起動しない。`file://`の重みはtarget側のregular fileからcopyする。HTTP(S)の重みはworker側の別clientで取得し、API tokenやCookieを転送せず、redirectを追わない。DatasetのURIは次節の規則でだけ取得する。

APIのArtifact（SIF、重み、source archive）は、SDKと同じRange再開で取得する。SIFや重みのstaging中に接続が切れても受信済みの位置から続け、全体のSHA-256をETagと照合してからtargetへ転送する。成果物と`.mmt/source.zip`などのRun Artifactは、64MiB以上ならupload sessionで送る。worker processが再起動しても、同じファイルなら続きから送る。

外部URLの重みのdownloadは、HTTPの`Content-Length`を圧縮された転送bodyのbytes数と照合する。保存ファイルのサイズとSHA256は展開後のbytesから計算する。`Content-Encoding`はidentity・gzip・deflateに対応し、gzip/deflateの末尾欠落やchecksum破損も拒否する。外部URLの重みはRange再開の対象外。workerは、APIがArtifactを圧縮して返した場合も同じ照合で1回だけ取得する（再開はしない）。

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

`path`はoutputs内の相対パス、`size`はbyte数、`mimeType`は255文字まで（省略時は`application/octet-stream`）。metricsは有限の数値で、`step`は非負の整数。省略したstepは0、timestampは回収時のUTC時刻になる。宣言した全fileのSHA256/size、未宣言file、symlink/hardlink/特殊file、絶対パスや`..`、`.partial`/`.tmp`を検査する。出力ディレクトリが空ならmanifestは不要。

| 上限 | 値 | 変え方 |
|---|---|---|
| 出力ファイル数（`artifacts`と`artifactsManifest`の合計） | 10000 | workerの`MMT_WORKER_MAX_OUTPUT_FILES`（1〜1000000） |
| `result.json` | 1MiB | 固定 |
| `artifactsManifest`の1行 | 4KiB | 固定（ファイル全体は「ファイル数の上限×4KiB」まで） |
| metrics | 1000点 | 固定 |
| `models` / `datasets` | 16件 / 64件 | 固定（APIのRunごとの上限と同じ） |

Python runtimeの出力も同じ検証・上限・転送になる。ファイル数の上限はtarget側のrunnerが検査するので、workerの設定はJobの起動時にspecで渡す（起動後に変えても、実行中のJobには効かない）。

entrypointが成功し、daemon/processが停止した後だけ結果を回収する。workerは出力を1本のtar streamで受け取り（下の「出力の一括転送」）、ファイルごとにSHA256とサイズを確認してRun Artifactの`container/<path>`へ保存する。続いてmetricsをlease付きworker APIへ送り、version 2の宣言があれば登録してからJobをcompleteする。結果検証やAPIの永久失敗はJobをfailedにする。cancel/nonzero exitの出力を成功結果として登録しない。ModelVersion/DatasetVersionの登録は、SDKまたはAPIで明示するか、`result.json` version 2で宣言するか、Taskの出力設定（次節）で行う。

### result.json version 2（出力モデル・出力Datasetの宣言）

SDKを入れないコンテナでも、実行時に決まる出力を自分で宣言して登録できる。version 1 の項目に `models`、`datasets`、`artifactsManifest` を足す。version 1 はそのまま使え、version 1 に新しい項目を書くと検証で失敗する。

```json
{
  "version": 2,
  "complete": true,
  "artifactsManifest": "artifacts.jsonl",
  "artifacts": [
    {"path": "model/weights.bin", "sha256": "<64桁hex>", "size": 1048576},
    {"path": "data/test.jsonl", "sha256": "<64桁hex>", "size": 2048, "mimeType": "application/jsonl"}
  ],
  "models": [{"path": "model/weights.bin", "metadata": {"epoch": 3}}],
  "datasets": [{"datasetId": "<DatasetのID>", "path": "data/test.jsonl", "digest": "sha256:<64桁hex>"}]
}
```

- `artifactsManifest` は JSON Lines の出力ファイル。1行に1件 `{path, sha256, size, mimeType?}` を書き、各行は `artifacts` に足して扱う。音声推論のように数千ファイルを出すときは、`result.json`（1MiBまで）に並べずこちらへ書く。空行は無視する。manifest自身と`result.json`はRun Artifactとして保存しない。
- `models[].path` と `datasets[].path` は `artifacts`（または `artifactsManifest`）に載せた出力ファイル。`modelId` は省略するとTaskの出力モデルへ登録する。Taskに出力モデルの設定が無いRunでは必須。Taskの出力モデルと別のModelは指定できない。
- `datasets[]` は `path` と `uri`（外部の場所）のどちらか一方。`digest` は必須。`schema`・`metadata` はJSON object。
- モデルを宣言できるのは training / finetuning の Run だけ（APIが422 `output_model_kind`で拒否し、Jobはfailedになる）。上限はRunごとにモデル16件・Dataset 64件で、超えた`result.json`はtarget側の検証で失敗する。
- workerは全Artifactの保存とmetricsの送信の後、complete の前に `POST /worker/jobs/:id/outputs` で宣言を送る。`index` は `models` を0から、続けて `datasets` を `models.length` からの通し番号にする。登録できた `index` はjournalに残し、worker再起動後は未登録の分だけを送る。応答が失われて再送しても同じ `index` なので二重登録にならない。
- worker token に `registry:write` が必要。宣言のAPIエラー（scope不足の403、Model・Datasetが無い404、上限超過やTaskと別Modelの422など）はJobをfailedにする。lease切れ（409 `invalid_lease`、401、410）だけはlease拒否として扱い、completeを送らない。
- 登録したバージョンの自動実行は学習Runの成功まで待ち、失敗・キャンセルなら skip される。

### 出力の一括転送（tar stream）

出力の回収は、target側runnerの`output-archive`コマンド1回（SSH接続1本）で行う。以前は64KiBごとに`output`コマンドを1回実行していたため、1GiBの出力で約1.6万回SSH接続していた。

1. runnerはentrypoint成功後の検証で、宣言された全ファイルの一覧（index、JSON Lines）をworkspaceの`output-index.jsonl`へ保存し、`state.json`には件数・合計サイズ・indexのSHA256・metrics・宣言だけを持つ（ファイル数が増えてもpollの応答が大きくならない）。
2. workerは保存済み（journalで確認済み）の`path:sha256`の一覧をstdinで渡して`output-archive`を起動する。runnerは非圧縮のtar（PAX形式）をstdoutへ書く。先頭のmemberがindex、続いて未確認のファイルをindexの順に並べる。
3. workerはstreamを読みながら、indexのSHA256を`state.json`の値と、各memberのpath・サイズ・順序をindexと照合する。regular file以外（symlink、hardlink、ディレクトリ、デバイス）、宣言外のpath、`..`や絶対パスを含むmemberがあれば、そのmemberを保存する前に回収を失敗させる。1ファイルずつ一時ファイルへ書きながらSHA256を計算し、一致したものだけを`artifact_uploads`（64MiB以上はupload session）で保存する。1ファイルでもSHA256が合わなければ、そのファイルを保存せずJobをfailedにする。
4. 保存できたファイルは`path:sha256`でjournalに記録する。journalの書き込みは最大1秒に1回にまとめる（1万ファイルで毎回journal全体を書き直すと遅いため）。worker processが落ちた場合、最後の1秒分のファイルを再び保存することがあり、同じ内容のArtifactのバージョンが1つ増える。
5. streamが途中で切れた、または300秒何も届かない場合は、通常の再接続（指数backoff）の後、未確認のファイルだけを指定してtarを取り直す。runnerが検証後に変わったファイルを見つけた場合は終了コード65で拒否し、workerは再試行せずJobをfailedにする。

workerが一度に持つのは1ファイル分の一時ファイルと、indexとjournal（1ファイルあたり数百byte）だけ。target側でも出力を圧縮・複製しない。tarは手で中身を確かめられる（`python3 <runner.pyz> output-archive <workspace> < /dev/null | tar tvf -`）。

SSHの接続共有（ControlMaster/ControlPersist）は、接続先の`sshd`の設定（`MaxSessions`など）や利用者の`~/.ssh/config`との干渉を確かめられていないため入れていない。tar転送で出力回収の接続数は定数になったので、残る接続はpoll（監視間隔ごとに1回）と起動前の転送になる。必要になったら、worker専用のControlPathをstate directoryに置き、`ControlPersist`を短く（例: 60秒）する案を検討する。

### Taskの出力設定で学習済みモデルを登録する

training/finetuningのTaskに`outputModel`を保存すると、そのTaskから起動したRunが`finished`になったとき、APIが`artifactPath`のArtifactをバージョンとして登録する。学習コードにSDKの登録処理は要らない。

| 項目 | 内容 |
|---|---|
| 登録先 | `modelId`（既存Model）か`createModel:{name,family}`（同じ名前があれば再利用、無ければ作成）。系列はTaskのCodeVersionの対応系列から選ぶ |
| `artifactPath` | Run Artifactのファイルpath。`MMT_OUTPUTS_DIR/model/weights.bin`なら`container/model/weights.bin`。同じpathが複数あれば最新 |
| バージョン名 | 省略時は整数の自動採番。`versionTemplate`は`{runId}`・`{runName}`・`{taskRevision}`を使える |
| 親バージョン・source | 親バージョンはRunの入力モデルバージョン（finetuningの元）、sourceRunはそのRun |
| 二重登録 | 学習コードが同じModelへSDKやMLflowで登録済みなら、Task側は`skipped`（`already_registered_by_run`）でバージョンは1件。下流の自動推論も1回だけ。別のModelへの登録はTask側を妨げない |
| 失敗 | Artifactが無い、Runの作成者が編集権限を失った、などは`failed`と理由を記録し、Runは`finished`のまま |
| 対象外 | failed/canceledのRun、テスト実行 |

結果は`GET /projects/:p/runs/:r/output-registration`、SDKでは`client.get_output_registration(project_id, run_id)`（記録前は`None`）で確認する。Taskの作成・更新では`mado_tracking.experiment_tasks.task_output_model(...)`で`output_model`を組み立てる。

```python
from mado_tracking.experiment_tasks import task_output_model

client.create_task(
    project_id, experiment_id=experiment_id, name="finetune", kind="finetuning",
    code_version_id=code_version_id, model_version_id=base_version_id, target_id=target_id,
    output_model=task_output_model(
        artifact_path="container/model/weights.bin",
        create_model={"name": "qwen2-finetuned", "family": "qwen2"},
    ),
)
```

Webの**コード**で選べる学習サンプルはSDKの登録処理を持たず、SDKで重みをRun Artifactの`model/weights.json`へ保存するだけで、この出力設定で登録する形になっている。`artifactPath`はファイルpathと完全一致で照合する。画面の既定値はこのサンプルに合わせた`model/weights.json`で、`MMT_OUTPUTS_DIR`へ書くコードでは`container/`で始まるpathに変える。

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

有効ruleは、その後に保存が確定したModelVersionから起動する。過去のバージョンは対象外。同じruleとモデルバージョンの組合せは一度だけqueueへ入る。`register_output_model()`もこの登録経路を使う。rule自体の受付状態と、作られたRun/Jobの実行状態は`automation-executions`で確認する。

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

training例はゼロから初期化してlossを記録し、weights.jsonをArtifactへ保存して、固定のModel `cpu-linear`に自動採番で出力ModelVersionを足す。終了後にRunの`outputModelVersionIds`からバージョンIDを取り出し、表示されたinferenceCodeVersionIdとともに新しいinference Runへ指定する。inference例は固定されたモデルバージョンのArtifactから重みを読み、予測結果をArtifactと出力DatasetVersionに保存する。

同じtrainingコードを`kind="finetuning"`のRunで実行すると、入力ModelVersionの`weight`と`bias`から学習を続ける。Runの`modelVersionId`へ固定された入力モデルバージョンを指定する。重みは`MMT_MODEL_FILE`があればそのファイルから、なければSDKの`download_input_model()`で読み込む。familyは`linear`、weight/biasは有限の数値であることを確認し、入力なし・不正な重みは失敗させる。出力ModelVersionには親バージョンIDと、実際に使った初期weight/biasを記録する。kindは接続したRunから判断し、`MMT_JOB_KIND`が指定されている場合は一致も確認する。

APIなしでも、明示した入力ファイルからのfine-tuningを試せる。

```bash
MMT_JOB_KIND=finetuning MMT_MODEL_FILE=python/.venv/example-weights.json \
  python/.venv/bin/python python/examples/training.py --offline --steps 5 --output python/.venv/fine-tuned-weights.json
```

## 学習を途中から再開する（checkpoint）

長い学習が止まっても、保存したcheckpointから新しいRunとして続きを回せる。再開は手動で、元のRunは変えない（失敗・停止の記録として残る）。

### 学習コードでcheckpointを保存する

```python
from mado_tracking import start_run

with start_run(kind="training", parameters={"steps": 1000}) as run:
    checkpoint = run.resume_checkpoint()          # 再開でなければNone
    if checkpoint is not None:
        state = load(checkpoint.path)              # read-onlyのディレクトリ
        start_step = checkpoint.step
    else:
        state, start_step = initial_state(), 0
    for step in range(start_step, 1000):
        loss = train_one_step(state)
        run.log_metrics({"train.loss": loss}, step=step)
        if (step + 1) % 100 == 0:
            save(state, "ckpt")                   # 重み、optimizerの状態、乱数の状態など
            run.log_checkpoint("ckpt", step=step + 1, includes_optimizer=True, framework="torch")
```

- `run.log_checkpoint(directory, step=, includes_optimizer=False, framework=None, metadata=None)`は、ディレクトリを1つのtarにまとめ、Run Artifact `checkpoints/step-<step>.tar`へupload sessionで送り（サイズにかかわらず再開可能な方式）、各ファイルのpath・sha256・sizeをmanifestとして`POST /projects/:p/runs/:r/checkpoints`へ登録する。symlinkを含むディレクトリと空のディレクトリは拒否する。同じRunの同じstepは409。
- tarは所有者・mode・時刻を固定して作るので、同じファイルからは同じbytesになる。
- `step`は「そこまでに終えたstep数」として扱うと、再開側が`range(checkpoint.step, total)`でそのまま続けられる。**metricの`step`は再開後も続きの値で記録する**（0から数え直さない）。Run詳細のグラフが1本につながる。
- `run.resume_checkpoint()`は`ResumeCheckpoint(path, step, checkpoint_id, source_run_id, includes_optimizer, metadata)`かNoneを返す。APIなしで試すときは`mado_tracking.checkpoints.resume_checkpoint_from_environment()`で同じ値を読める。
- MLflowで`mlflow.log_artifacts(dir, "checkpoints/step-<N>")`のように`checkpoints/step-<整数>/`の下へ保存したファイルも、training/finetuningのRunなら自動でcheckpointになる（同じstepの最初のファイルで作り、以降のファイルをmanifestへ足す）。Runが終わった後はそのstepへファイルを足せない（409）。
- checkpointはRunごとに既定5件（APIの`MMT_CHECKPOINT_KEEP_COUNT`）を一覧に出し、古いものは`retained=false`で既定の一覧から外す。Artifactは消さないので、外れたcheckpointからも再開できる。

### 再開する

- Webの**Run詳細**の**Checkpoint**タブで、失敗・停止したRunの行の「このcheckpointから再開」を押すと、そのRunのJobをretryして新しいRunへ移る。**Jobs**の「最新checkpointから再開」は最大stepのcheckpointを選ぶ（そのRunにcheckpointが無く、Run自体が再開Runなら、その再開元を引き継ぐ）。
- APIでは`POST /projects/:p/jobs/:j/retry`の本文`{checkpointId}`か`{resumeFromLatestCheckpoint:true}`、Task起動・Run作成の`resumeCheckpointId`。再開できるのは、checkpointと同じProjectで、元のRunと同じkind（trainingまたはfinetuning）、同じCode（バージョンは違ってよい）のRunだけ。
- 新しいRunには`resumeCheckpointId`、`environment.resume={checkpointId, sourceRunId, step}`、`parentRunId`（元のRun）が入り、Jobの作成後は変えられない。

### workerが行うこと

1. claimしたWorkerJobの`resumeCheckpoint`（id、元のRun、step、source、Artifact一覧、manifest）を、RunのresumeCheckpointIdと一致するか確かめる。
2. Artifactを認証済みAPIからRange再開つきで取得し、Artifactごとにsha256とsizeを照合する。SDKのcheckpoint（tar 1個）はそのまま、MLflowのcheckpoint（ファイルごとのArtifact）は検証後にtarへまとめる。
3. tarの中身がmanifestと完全に一致する（余分なファイル・不足・sha256違い・`..`やsymlinkが無い）ことを確かめてからtargetへ送り、target側でもtarのsha256を確かめてから展開する。
4. 展開先はworkspaceの`inputs/checkpoint`で、ファイルは400、ディレクトリは500。コンテナでは`/mmt/inputs`のread-only mountの下（`/mmt/inputs/checkpoint`）に見える。
5. `MMT_RESUME_CHECKPOINT_DIR`、`MMT_RESUME_STEP`、`MMT_RESUME_CHECKPOINT_FILE`を渡す。`resume-checkpoint.json`は`{checkpointId, sourceRunId, step, source, files, includesOptimizer, framework, metadata}`で、host pythonはworkspace直下、コンテナは`/mmt/context/resume-checkpoint.json`。

どこかで照合に失敗したら、entrypointを起動せずにJobを`failed`にし、理由をJobのerrorに残す。

### サンプルで途中失敗と再開を試す

`examples/training.py`はmomentum付きSGDで、`--checkpoint-every N`（parameters の`checkpoint_every`）ごとに重み（`model.json`）とoptimizerの状態とstep（`optimizer.json`）を保存する。`--fail-at-step`で途中失敗を起こせる。同じ乱数を使わない決定的な計算なので、再開した最終の重みとoptimizerの状態は通しで学習した結果と一致する（`tests/test_checkpoint_resume.py`で確認している）。

```bash
python/.venv/bin/python python/examples/training.py --offline --steps 40 --checkpoint-every 10 \
  --fail-at-step 27 --output /tmp/mmt-ckpt/weights.json   # step 27で失敗。checkpoints/step-10, step-20が残る
echo '{"checkpointId":"local","sourceRunId":"local","step":20}' > /tmp/mmt-ckpt/resume.json
MMT_RESUME_CHECKPOINT_DIR=/tmp/mmt-ckpt/checkpoints/step-20 MMT_RESUME_STEP=20 \
MMT_RESUME_CHECKPOINT_FILE=/tmp/mmt-ckpt/resume.json \
  python/.venv/bin/python python/examples/training.py --offline --steps 40 --checkpoint-every 10 \
  --output /tmp/mmt-ckpt/resumed.json
```

APIに接続したRunでは、同じ保存が`run.log_checkpoint`でRunのcheckpointとして登録される。

## SSH切断後も同じjobへ復帰する

targetの`workDirectory/<job-id>/`にrunner、SDK、source、venvと実行状態を置く。`start.lock`で同じjobの二重起動を防ぎ、`state.json`にsupervisor/commandのPID、Linux boot IDと起動時刻、exit statusを保存する。stdout/stderrはsecret値を伏せてから専用ファイルへ保存する。tokenやsecretを含むspec.jsonは600で保存し、terminal状態の確定後に削除する。

workerは起動時に`POST /worker/resume`とlocal journalで保持中のjobを回収し、同じleaseをheartbeatで確認して再接続する。ログをAPIが受け付けた位置はjournalへ保存する。起動応答が失われても、同じworkspaceへの再送は既存の実行状態を返す。別workerへの再claimや自動再実行は行わない。

API/SSHの一時障害は指数backoffで再接続する。claimの応答が失われた場合、追加claimより先にresumeで回収する。401/403/404/409/410によるlease拒否では状態変更と新規起動を止める。supervisor消失後にprocessが残っている場合や、PID保存前の起動状態が不明な場合はleaseを維持して再起動を拒否する。状態ファイルを消して再実行しないこと。不明な実行の確認が必要ならcompute target管理者へjob IDとstate.jsonの状態を伝える。

logsとmetricsは少なくとも1回送る方式。APIの保存成功後に応答だけ失われた場合、同じchunkが再送されることがある。completeは同じlease/statusで再送でき、workerも未送信の完了状態をjournalへ保存する。

## workerの在籍と応答途絶を確認する

workerはclaimとresumeで`workerInfo`（パッケージ`mado-tracking`のバージョンとホスト名）をAPIへ送る。APIはtoken IDとworkerIdの組で`workers`へ記録し、Compute画面の「Workers」に接続状態、バージョン、ホスト名、最終応答、担当Job数を出す。一覧は`GET /projects/:p/workers`（viewer）と`GET /workers`（全体管理者）でも読める。

- workerは120秒応答がないと「オフライン」になる。idleでも毎秒claimするので、通常はオンラインのまま。
- claimは毎秒届くため、最終応答の書き込みは15秒ごとにまとめる。表示される最終応答は最大15秒古い。
- Jobのheartbeatが60秒途絶すると、Jobs画面に「応答なし」を出す。Jobの状態、GPUの予約、leaseは変えず、再claimや自動再実行もしない（前節の方針）。止まったままのJobは、workerホストで状態を確認してからcancelやretryを手で行う。
- バージョンは`importlib.metadata`で読む。インストールせずに動かしている場合はバージョンを送らず、画面は「—」になる。
- `parallelJobs`はAPIでは受け付けるが、現在のworkerはまだ送らない。

## Compute targetの接続を確認する

最初のJobを流す前に、targetへSSHで入れるか、Python・venv・pip・git・Docker・Apptainer/Singularity・GPUが使えるかを、全体設定の「コンピュータ」（`/settings/computers`）の「接続を確認」で確かめる（所有者か全体管理者）。API serverはSSH鍵を持たないので、確認はそのtargetを担当するworkerが自分の鍵で行う。

- 確認するのは`MMT_WORKER_TARGET_IDS`にそのtargetを含むworkerだけ。`MMT_WORKER_TARGET_IDS`の無いworkerは確認をclaimしない。依頼から5分claimされなければ「workerがありません」（`no_worker`）で終わる。
- workerはJobのclaimが空いた間に5秒間隔で`POST /worker/target-checks/claim`を呼び、Jobの監視と並行して確認する。確認は同時に1件。
- 確認は3段階で、最初に失敗した段階を結果にする。
  1. `true`を送ってSSH接続を確かめる（失敗は`ssh_failed`。sshのエラー文は鍵のパスを含みうるので結果に入れない）。workerホストに鍵やknown_hostsが無い・鍵の権限が600でないときは接続せずに`ssh_configuration`で`failed`にする。
  2. `pythonExecutable -c`でPythonのバージョンと実行パスを得る（無ければ`python_missing`、3.11未満は`python_too_old`）。
  3. 固定の確認スクリプト（`worker/target_probe.py`の`PROBE_SCRIPT`。Python 3.6以上の標準ライブラリだけ）を送り、構造化JSONで受け取る。各コマンドは15秒、全体は90秒で打ち切る。
- 確認する項目: venvとensurepip、`python -m pip --version`、`git --version`、`docker --version`と`docker version`（daemonへの到達。届かないときはsocketの読み書き権限で`docker_socket_denied`と`docker_daemon_unreachable`を分ける）、`apptainer`/`singularity`のバージョンと`exec --help`の必須flag（`sif_container.py`の`REQUIRED_SIF_FLAGS`と`--nv`）、`nvidia-smi --query-gpu=index,uuid,name,memory.total`、`workDirectory`（無ければ一番近い既存の親）への書き込みと空き容量、targetから`MMT_API_URL/health`への到達。
- 確認はtargetに何も残さない（作業ディレクトリも作らない。書き込み確認の一時ファイルはすぐ消す）。
- GPUはnvidia-smiが報告した値だけを返す。nvidia-smiが無ければ`gpus=null`で、GPUを設定したtargetではNG、CPUだけのtargetでは「なし」。
- 画面は検出したGPUのindexと確認に通ったRuntimeを候補として示す。targetの`gpuIds`・`runtimeKinds`は管理者が「選んだ候補を保存」を押したときだけ変わる。
- 結果の文字列は1行200文字以下に切り、worker tokenはマスクし、targetの鍵・known_hostsのパスを含む文字列は捨てる。APIも同じ検査をして、含んでいれば保存しない。

## ジョブを止めるとprocess groupが終了する

APIの`POST /projects/:p/jobs/:j/cancel`を使う。heartbeatは実行・ログ転送と並行し、cancelRequestedを受け取るとjob workspaceへ停止要求を保存する。runnerは実行中のprocess groupへSIGTERMを送り、10秒以内に終了しなければSIGKILLする。setup中のGit/pipも停止対象。子processも終了してから`canceled`を同じleaseでcompleteする。

entrypointが正常終了した場合も、そのprocess groupに残る子を停止する。子がstdout/stderrを継承していても、pipeのEOFとは別にentrypoint終了を検出し、SIGTERM→同じgrace期限→SIGKILLで後始末する。停止中の出力と残りのログはsecret maskingして回収し、子が実際に停止したことを確認してからJobを完了する。子の停止にSIGKILLが必要でも、entrypointのexit code 0を保持してJobを`finished`でcompleteする。

worker自身のSIGTERM/SIGINTは監視を止め、journalを残す。detachされたjobは実行を続け、同じworkerの再起動で回収する。ジョブの停止は前段のcancel APIで行う。

DockerはJob IDに対応するcontainer名と、Job/CodeVersion/project/lease/workspaceのlabelを保存する。復帰時はlabel、固定image、container IDを照合して既存containerへattachし、`docker start`を再送しない。supervisorが消失しても、監視専用supervisorを復旧して同じcontainerを回収する。未起動containerを再実行することはない。[Docker create/startの仕様](https://docs.docker.com/reference/cli/docker/container/create/)

取消やログclientの失敗では、daemon側をSIGTERM→grace期限で停止し、containerの削除と不在を確認する。entrypointの終了時も残るprocessをdaemon側で片付ける。`docker logs`などのclientをkillしただけでは完了しない。daemonへ接続できない、または所有を照合できない間はleaseとGPU予約を維持する。supervisor復旧時はDockerログが再送される場合がある。SIFは記録したboot ID・PID起動時刻・session/process groupを照合し、子の停止を確認する。

Dockerのログthreadを作成・開始できない場合やjoinが失敗した場合も、所有containerの停止・削除と不在確認を行う。`unknown`状態は、supervisor・process group・起動途中のprocess・未解放containerのいずれかが残る可能性があれば完了しない。supervisor生存中の`unknown`や、生存情報が欠けた応答でもleaseとGPU予約を保持する。既存Python実行は、supervisorとprocess groupが消失し、起動途中でもないことを確認できた場合にfailed完了する。

## system metricsを採取する

SDKとworkerは同じ収集処理`mado_tracking.system_metrics`を使う。名前は従来のworkerの名前を変えず、追加分も同じ規則で付ける。

| 名前 | 内容 |
|---|---|
| `system.cpu.percent` | コンピュータ全体のCPU使用率。前回値との差分で求める |
| `system.cpu.load1` | 1分のload average。`psutil`が無い環境だけで出す（従来の記録との互換） |
| `system.memory.used_bytes`・`system.memory.percent` | コンピュータ全体のmemory |
| `system.process.memory_bytes` | 対象PIDと子孫processのRSS合計（PIDを指定したときだけ） |
| `system.disk.used_bytes`・`system.disk.percent` | 作業ディレクトリのファイルシステム |
| `system.disk.read_bytes_per_second`・`system.disk.write_bytes_per_second` | 物理disk全体の読み書き量 |
| `system.network.sent_bytes_per_second`・`system.network.received_bytes_per_second` | loopbackを除く全interfaceの送受信量 |
| `system.gpu.<index>.utilization_percent`・`memory_used_bytes`・`memory_total_bytes`・`temperature_celsius`・`power_watts` | GPUごとの値。`<index>`はnvidia-smi/NVMLの番号 |

- disk・networkの毎秒量は前回値との差分を経過時間で割る。初回の採取では出さず、counterが巻き戻ったときもその回は出さない。
- workerはpollごとにrunnerのprocessが変わるため、前回値をJobのworkspaceの`telemetry-state.json`へ残し、2回目のpollから毎秒量を出す。
- GPUは (1) NVML（`nvidia-ml-py`の`pynvml`）、(2) `nvidia-smi`（timeout 3秒）、(3) なし、の順に試す。使えなかった理由は最初の1回だけ`logging.debug`に出し、同じ採取器では使えなかった方法を再試行しない。`nvidia-smi`のtimeoutはその回だけGPU値を省く。
- 対象GPU: workerはJobに割り当てたGPU（番号またはUUID）だけ。GPUなしのJobではNVMLもnvidia-smiも呼ばない。SDKのRunでGPUを指定しない場合は全GPUを読み、`CUDA_VISIBLE_DEVICES`があればその番号・UUIDに絞る（空・`-1`はGPUなし）。番号はnvidia-smiの番号として解釈する（`CUDA_DEVICE_ORDER=PCI_BUS_ID`でCUDAの番号と揃う）。
- `psutil`が無い環境では`/proc`からCPU（`/proc/stat`の差分）、memory（`/proc/meminfo`）、network（`/proc/net/dev`）、disk（`/proc/diskstats`。`/sys/block`にある物理diskだけを数え、partition・loop・dm・mdは二重計上を避けて除く）を読む。Linux以外では出せる分だけ出す。どの段階で失敗しても例外を外へ出さず、取得できない値を架空の数値で埋めない。
- 間隔: workerは`telemetry_seconds`（既定10秒）。SDKの`SystemMetricsMonitor`は既定15秒、下限1秒（毎秒だとmetricsの行数が増えすぎるため）。stepは0からの連番。monitorの`stop()`はthreadの終了を待ち、停止後に採取した値は送らない。送信先（sink）の例外は数えて警告し、採取は続ける。
- `pip install 'mado-tracking[telemetry]'`で`psutil`と`nvidia-ml-py`が入る。どちらも無くても動く。

### MLflowの`system/`名との対応

公式MLflow 3（`mlflow.enable_system_metrics_logging()`）は`system/`接頭辞で記録する。MadoのMLflow APIはこの名前をそのまま保存し、get-historyで読める（2026-10-08、MLflow 3.0.0と3.17.0で確認。`artifacts/verification/2026-10-08/system-metrics/`）。WebのRun詳細「System metrics」タブは、両方の名前を同じ分類（CPU、メモリ、ディスク、ネットワーク、GPUごと）と単位の図にまとめる（`apps/web/src/lib/systemMetricKeys.ts`）。MLflowのMB（10^6）はbytesに換算して同じ図に置く。MLflowのnetworkは累積MBなので、Madoの毎秒量とは別の図「ネットワーク（開始からの累計 bytes）」にする。表に無い`system`名は1つずつ別の図にする。

| Mado | MLflow | 単位の違い |
|---|---|---|
| `system.cpu.percent` | `system/cpu_utilization_percentage` | 同じ |
| `system.memory.used_bytes` | `system/system_memory_usage_megabytes` | MLflowはMB（10^6） |
| `system.memory.percent` | `system/system_memory_usage_percentage` | 同じ |
| `system.disk.used_bytes` | `system/disk_usage_megabytes` | MLflowはMB |
| `system.disk.percent` | `system/disk_usage_percentage` | 同じ |
| （なし） | `system/disk_available_megabytes` | |
| `system.network.received_bytes_per_second` | `system/network_receive_megabytes` | MLflowは監視開始からの累積MB。毎秒量ではない |
| `system.network.sent_bytes_per_second` | `system/network_transmit_megabytes` | 同上 |
| `system.gpu.<i>.utilization_percent` | `system/gpu_<i>_utilization_percentage` | 同じ |
| `system.gpu.<i>.memory_used_bytes` | `system/gpu_<i>_memory_usage_megabytes` | MLflowはMB |
| （`memory_used_bytes`/`memory_total_bytes`から算出） | `system/gpu_<i>_memory_usage_percentage` | |
| `system.gpu.<i>.power_watts` | `system/gpu_<i>_power_usage_watts` | 同じ |
| `system.gpu.<i>.temperature_celsius` | （なし） | |

MLflowのGPU値は`pynvml`が入っているときだけ出る。GPUの無い環境ではGPU系は出ない（上記の確認もGPUなしのコンピュータで行った）。

公式MLflowでの確認は次で行う。

```bash
<MLflow 3の検証用venv>/bin/python -I scripts/mlflow3_checks/system_metrics.py
<MLflow 3の検証用venv>/bin/python -I scripts/mlflow3_checks/system_metrics.py --mado-api-url http://127.0.0.1:<検証API>
```

venvには`mlflow`・`psutil`・`httpx`が要る（MLflow 3.0.0は`sqlalchemy<2.1`も）。既定は一時的なローカルMLflow storeへ記録する。`--mado-api-url`ではdev-loginでProjectと1時間の一時tokenを作ってMadoのMLflow APIへ記録し、最後にtokenを失効する。結果は`artifacts/verification/<日付>/system-metrics/mlflow-<バージョン>-<local|mado>.json`。

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

Dockerの挙動テストはcached digest imageを明示して実行する。SDKなしfixtureの`python/examples/container_fixture.py`はAlpine/BusyBoxで動き、read-only入力、結果file、metrics、token maskingを確認する。`BULK_OUTPUT_FIXTURE_SCRIPT`は1000ファイルを`artifactsManifest`で宣言し、`result.json` version 2でモデルを宣言する。`MMT_EXAMPLE_DOCKER_IMAGE`を指定すれば、実API用のCodeVersionも登録できる。

```bash
MMT_TEST_DOCKER_IMAGE='alpine@sha256:<cached digest>' python/.venv/bin/pytest python/tests/test_docker_worker.py
```

出力の一括転送は`python/tests/test_output_archive.py`で、5000ファイルの出力が`output-archive`の1回で届くこと、宣言外・`..`・symlink・hardlinkのmemberの拒否、途中切断後に未確認pathだけを取り直すこと、1ファイルのSHA256違いで回収が失敗することを確かめる。

Docker testsでは成功/失敗、1000ファイルの出力とモデルの宣言、出力検証/API保存失敗、daemon取消、worker/supervisorの復帰、失われた起動応答を確認する。SIFはCLI fixtureと実process groupでSHA、GPU選択env、取消、secret masking、出力回収を検証する。実SIF image、実SSH、GPU driver/Toolkitを含む結合は未確認。wheelから作ったremote zipappにも各runtime moduleを含める。

親担当は`scripts/verify_worker.py`で、独立した実API/PostgreSQLとlocal durable workerの結合検証を完了している。対象はCPU training/inference、finetuningの種別と親モデル、cancel/retry/reconnect。結果は`artifacts/verification/2026-10-08/worker-integration.json`。Python testsでは、入力重みからのfine-tuningを別途確認している。実SSH・実GPUには接続していない。結合検証では開発用の独立DB/APIを使い、既存アプリへ接続しない。

用語: Runは実験記録、Jobは実行要求、CodeVersionは不変のsourceと起動設定、leaseはworkerの実行権限、journalは復帰用のlocal記録、workspaceはjob別の実行ディレクトリ。契約の疑問はapi-contract.mdとcontractsを確認し、変更は担当coordinationメモで親担当へ渡す。

更新: 2026-10-08。
