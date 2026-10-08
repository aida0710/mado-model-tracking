# API契約 v0.1

本体はTypeScript/Hono＋PostgreSQL、React/Vite、Python worker/SDK。Mado pluginは別リポジトリのHTTP service。JSONはcamelCase。成功時はentityを直接返す。一覧は`{items: T[]}`。エラーは`{error:string,code?:string}`で適切な4xx/5xx。IDはUUID、日時はISO UTC。版とRunの参照は不変。外部のサンプルを自動で本番へseedしない。

## Web/SDK

prefix `/api`。WebはHttpOnly session cookie、SDKはBearer token。Cookieによる変更はOrigin検証。viewer=読む、editor=実験/登録/実行、admin=project設定/メンバー/token/plugin。API tokenはscopeとproject membershipを両方確認する。

- `GET /health` → `{status:'ok'}`。DB障害は503。
- `GET /auth/config` → AuthConfig。`GET /auth/me` → `{user:User}` (未認証401)。`POST /auth/dev-login` → `{user}`はdevelopment modeだけ。`GET /auth/login` / `GET /auth/callback` / `POST /auth/logout`。
- `GET /projects` / `POST /projects` (name,description?,artifactBackend?) / `PATCH /projects/:id` (description?,artifactBackend?)。
- `GET /projects/:p/members` / `PUT /projects/:p/members/:userId` (role)。管理者以外は権限変更不可。
- `GET|POST /projects/:p/experiments` (name,description?)。
- `GET /projects/:p/runs?experimentId=&status=&q=&limit=` / `POST /projects/:p/runs` (experimentId,name,kind,parameters?,tags?,modelVersionId?,codeVersionId?,inputDatasetVersionIds?,parentRunId?,environment?)。
- `GET|PATCH /projects/:p/runs/:r` (PATCH:name?,parameters?,tags?,status?,environment?; job紐付きの状態はworkerが管理)。parametersはキー単位merge。job実行開始後は実行設定の変更を拒否する。CodeVersionがあるRunは`environment.runtime`に実際のruntimeを固定し、environmentの置換でも維持する。異なるruntimeへの変更は拒否する。再実行は新しいRun。
- `GET|POST /projects/:p/runs/:r/metrics` (POST:{metrics:MetricPoint[]})。
- `GET|POST /projects/:p/runs/:r/logs` (POST:{entries:LogEntry[]})。
- `GET /projects/:p/runs/:r/artifacts` / `PUT /projects/:p/runs/:r/artifacts?path=` (raw binary、Content-Type; Artifactを返す)。Run無しの登録は`PUT /projects/:p/artifacts?path=`。
- `GET /projects/:p/artifacts?query=&limit=` → `{items:Artifact[]}`。Projectの保存済みArtifact一覧で、limitは既定100、最大500。`GET /projects/:p/artifacts/:a` → Artifactのmetadata。viewer/readで参照でき、保存先のblobは読み込まない。
- `GET /projects/:p/artifacts/:a/content` (Range対応。危険なHTML/SVG等はattachment)。`GET /storage/backends` → `{items:('filesystem'|'s3')[]}`。
- `GET|POST /projects/:p/models` (name,family,description?) / `GET|POST /projects/:p/models/:id/versions` (version,parentModelVersionIds?,sourceRunId?,weightsUri?,artifactId?,defaultCodeVersionId?,metadata?)。
- `PUT /projects/:p/models/:id/aliases/:alias` ({versionId})。実行時はaliasではなく実際のModelVersion IDをRunへ保存。
- `GET|POST /projects/:p/codes` (name,description?) / `GET|POST /projects/:p/codes/:id/versions` (version,source?,runtime?,entrypoint,requirements?,environment?,supportedModelFamilies,taskTypes)。source/runtime/entrypointは下記とcontracts参照。Qwen2/Qwen3の組合せをサービスで検証。training/finetuningも同じCodeVersion契約を使う。
- `GET|POST /projects/:p/datasets` (name,namespace?,description?) / `GET|POST /projects/:p/datasets/:id/versions` (version,uri,digest,schema?,metadata?,sourceRunId?,parentDatasetVersionIds?,externalRef?)。sourceRunIdがあればRun.outputへ関係を保存。
- `GET /projects/:p/lineage` → LineageGraph。
- `GET|POST /targets` (ComputeTargetのidを除く。作成はglobal admin)。`runtimeKinds`は重複のないPython/Docker/Singularity/Apptainerの一覧で、省略時は`['python']`。取得時に鍵パス等を一般viewerへ出さない。executor=localはdevelopmentの明示許可のみ。
- `GET /projects/:p/jobs` / `POST /projects/:p/jobs` (runId,targetId,gpuIds?,maxAttempts?)。Run kindとCodeVersion taskTypes、モデル系列、固定runtimeとtargetの対応runtime、GPU一覧、参照projectを検証。
- `POST /projects/:p/jobs/:j/cancel` / `POST /projects/:p/jobs/:j/retry`。retryは新Run/Jobを作り`{run,job}`。生きているleaseのGPUを解放しない。
- `GET|POST /tokens` (POST:name,kind,projectId,scopes,expiresAt?; `{token:string,item:TokenSummary}`一度だけ返す)。`DELETE /tokens/:id`。tokenはhashのみ保存。scope候補は`read`,`runs:write`,`registry:write`,`artifacts:write`,`jobs:write`,`worker:execute`,`admin`。worker tokenは設定されたprojectのみclaim可能。
- `GET|POST /projects/:p/plugins` (POST:name,baseUrl,tokenEnv,enabled?)。登録は全体管理者に限定し、plugin secretは環境変数参照。Project adminは登録済みのpluginを利用する。`POST /projects/:p/plugins/:id/check` → manifest。`POST /projects/:p/plugins/:id/datasets/search` ({query}) → `{items:PluginDataset[]}`。
- `POST /projects/:p/plugins/:id/datasets/import` ({dataset:PluginDataset}) → DatasetVersion。`POST /projects/:p/plugins/:id/events/retry` → `{queued:number}`。`GET /projects/:p/plugins/:id/metrics` → `{prometheus:string}`（storage:metrics対応pluginのみ）。event outboxはRun状態のtransactionと一緒に保存し、plugin障害でRunを失敗させない。

## コンテナのCodeVersion

`runtime`は省略時に`{kind:'python'}`へ正規化する。既存CodeVersionとtargetもmigrationでPythonへ移行する。版はruntimeを含めて更新不可。

- Python: `{kind:'python'}`。Gitの固定commit、inline files、保存済みArtifactのいずれかの`source`が必須。
- Docker: `{kind:'docker',image,workingDirectory?}`。imageは`repository[:tag]@sha256:<64桁の小文字hex>`へ固定する。registry/portを含むreferenceも登録できる。APIはregistryに接続しない。
- Singularity/Apptainer: `{kind:'singularity'|'apptainer',artifactId,sha256,workingDirectory?}`。保存完了済みArtifactを同じProjectで照合し、SHA256の完全一致を確認する。Job登録とworker claimでも再確認する。

コンテナは`source`を省略またはnullにでき、任意のGit/inline/Artifact sourceも追加できる。Artifact sourceも同じProjectに限定する。コンテナの`requirements`は空にする。pip依存の指定はPythonで使う。`entrypoint`は空でないargv配列で、NULを含む引数は拒否する。`workingDirectory`はコンテナ内の絶対パスで、`..`などの脱出を拒否する。未知のruntimeフィールド、系列/taskTypesの重複も拒否する。hostのsupervisor用Pythonはtargetの`pythonExecutable`を引き続き使う。

Runは固定CodeVersion IDと`environment.runtime`を保存する。Job登録時とworker claim時に固定内容が一致することを確認し、targetが対応しないruntimeのJobは実行しない。

## モデル登録後の自動実行

- `GET /projects/:p/automation-rules` → `{items:ModelAutomationRule[]}`。
- `POST /projects/:p/automation-rules` → ModelAutomationRule、201。bodyは`name,modelFamilies,kind,experimentId,codeVersionId,targetId,gpuIds?,inputDatasetVersionIds?,parameters?,tags?,maxAttempts?,enabled?`。`kind`は`inference`または`evaluation`。`enabled`はtrue、GPU/入力は空、parameters/tagsは空、maxAttemptsは3が既定。
- `PATCH /projects/:p/automation-rules/:id` ({enabled:boolean}) → ModelAutomationRule。設定は不変で、有効/無効だけを切り替える。設定変更は新しいruleを登録する。
- `GET /projects/:p/automation-executions` → `{items:ModelAutomationExecution[]}`。最新100件を返す。

作成・切替はProject adminまたはglobal adminだけが行える。API tokenには`admin` scopeに加え、Project制限と現在のmembershipを要求する。読む操作はviewerと`read` scope。CodeVersion、Experiment、入力DatasetVersionは同じProjectで照合し、モデル系列/kind、targetの有効状態/runtime/GPUも登録時に検証する。ruleには`createdBy`を保存する。登録処理では作成者の現在のProject admin/global admin権限を再確認し、失効していれば`skipped`を記録する。

ModelVersion登録のtransaction内で、同じ系列の有効ruleを判定し、共通のRun/Job登録処理を使って自動実行をqueueへ追加する。SDKのモデル出力登録もこの経路を通る。保存済み重みArtifactをProjectで照合する。`weightsUri`の実体はworkerが取得確認し、APIからはfetchしない。重みが指定されていなければ`skipped`を記録する。Artifact uploadだけでは起動しない。

登録イベントは`model_automation_events`で一度だけ処理し、executionにも`UNIQUE(rule_id,model_version_id)`を設ける。モデル登録と同じtransactionなので外側のrollbackではRun/Job/イベントも残らない。各ruleの失敗はsavepointでRun/Jobをrollbackして`failed`と安全なerror文字列を保存し、ほかのruleとModelVersion登録を残す。設定が変わったtargetや不正な参照もここで再検証する。過去モデル、disabled中の登録、有効ruleがない登録へは遡及しない。失敗・skipした登録イベントの再送でも自動実行を増やさない。

自動Runはruleの固定CodeVersion/設定を使い、`sourceRunId`を`parentRunId`へ関連付ける。`tags['automation.ruleId']`と`environment.automationRuleId`にrule ID、`environment.runtime`に固定runtimeを保存する。executionの`status`は登録時の結果（queued/failed/skipped）で、実行後も変わらない。`runStatus`と`jobStatus`で現在の実行状態を返し、Run/Jobを作らなかった場合はnullになる。

## Worker API

- `POST /worker/claim` ({workerId,targetIds?:string[],activeJobIds?:string[]}) → `{item:WorkerJob|null}`。DB transaction＋SKIP LOCKED、target/GPU予約、worker project scope、ランダムleaseを使う。targetが対応しないruntimeは候補から除外し、返す前にも版/runtime/Artifact/GPUを再検証する。検証失敗でleaseやGPU予約は残らない。activeJobIdsは既に監視中のJobを指定する。そのID以外に同じworkerの未完了Jobがあれば同じleaseで回収し、なければ次をclaimする。同じpayloadの再送で新たなJobを重複claimしない。
- `POST /worker/resume` ({workerId,targetIds?:string[]}) → `{items:WorkerJob[]}`。同じworkerIdとproject scopeのclaimed/running jobを同じleaseのまま返す。別workerへ自動再claimしない。
- `POST /worker/jobs/:id/heartbeat` ({leaseId,status?:'running'}) → `{cancelRequested:boolean}`。
- `POST /worker/jobs/:id/metrics` ({leaseId,metrics:MetricPoint[]})、`POST .../logs` ({leaseId,entries:LogEntry[]})。
- `POST /worker/jobs/:id/complete` ({leaseId,status:'finished'|'failed'|'canceled',exitCode?,error?})。同じleaseの再送は安全。古いleaseからの状態変更を拒否。
- WorkerはAPI heartbeatと並行してSSH commandを実行する。切断してもremote processを二重起動しないためjob別workspaceのPID/statusファイルでattach・回収する。worker停止後のleaseは安易に再実行せず、同じworkerの復帰で再attachするか状態不明として扱う。再実行は明示操作。
- GPUなしのCPU実行はgpuIds=[]。実際のGPU計測はnvidia-smiで任意に採取。WorkerはAPI/ログへ鍵・token・シークレット値を出さない。
- 環境: `MMT_API_URL`, `MMT_API_TOKEN`, `MMT_WORKER_ID`, `MMT_WORKER_TARGET_IDS`。SDKはstart_run、log_params/tags/metrics、log_artifact、register_model/dataset等を提供。例と実行する小さいtraining/inference scriptを同梱する。

## Platform保存API（親担当）

`@mmt/platform`は`createArtifactStoresFromEnv(env?)` → `ArtifactStores`をexportする。`stores.backends():ArtifactBackend[]`、`stores.put({backend,key,body:Readable,mimeType})` → `{size,sha256}`、`stores.read({backend,key,range?:string})` → `{body:Readable,size,totalSize,contentRange?:string,status:200|206}`。`stores.remove({backend,key})`。keyはprojectId/artifactId配下の不変ID。登録DB失敗時は書いたblobをcleanup。streamingでGBファイルを全量メモリへ載せない。`.env`設定は`ARTIFACT_FILESYSTEM_ROOT`、`S3_BUCKET`, `S3_ENDPOINT?`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`。FSは常時available、S3は必要設定がある場合available。

`createPluginClient({baseUrl,token})` → `manifest()`, `searchDatasets(query)`, `metrics()` → `{prometheus:string}`, `sendEvent(event)`。HTTP POST `/datasets/search`、`/events`、GET `/manifest`。deadlineとvalidation必須。専用pluginはprivate networkで管理者が設定する。任意ユーザーがURLを指定できない。

## ローカル検証

親担当は独立PostgreSQL containerとポート55483、API4182、Web5182を使う。既存Mado DB等を変更しない。テストDB URLは親が`artifacts/coordination/2026-10-08/environment.json`に認証情報を含めず案内する。migrationは担当が作成しrootが適用する。Web表示は実APIのseedデータを使い、API失敗をダミーデータで隠さない。
