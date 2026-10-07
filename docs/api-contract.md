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
- `GET|PATCH /projects/:p/runs/:r` (PATCH:name?,parameters?,tags?,status?,environment?; job紐付きの状態はworkerが管理)。parametersはキー単位merge。job実行開始後は実行設定の変更を拒否する。再実行は新しいRun。
- `GET|POST /projects/:p/runs/:r/metrics` (POST:{metrics:MetricPoint[]})。
- `GET|POST /projects/:p/runs/:r/logs` (POST:{entries:LogEntry[]})。
- `GET /projects/:p/runs/:r/artifacts` / `PUT /projects/:p/runs/:r/artifacts?path=` (raw binary、Content-Type; Artifactを返す)。Run無しの登録は`PUT /projects/:p/artifacts?path=`。
- `GET /projects/:p/artifacts/:a/content` (Range対応。危険なHTML/SVG等はattachment)。`GET /storage/backends` → `{items:('filesystem'|'s3')[]}`。
- `GET|POST /projects/:p/models` (name,family,description?) / `GET|POST /projects/:p/models/:id/versions` (version,parentModelVersionIds?,sourceRunId?,weightsUri?,artifactId?,defaultCodeVersionId?,metadata?)。
- `PUT /projects/:p/models/:id/aliases/:alias` ({versionId})。実行時はaliasではなく実際のModelVersion IDをRunへ保存。
- `GET|POST /projects/:p/codes` (name,description?) / `GET|POST /projects/:p/codes/:id/versions` (version,source,entrypoint,requirements?,environment?,supportedModelFamilies,taskTypes)。source/entrypointはcontracts参照。Qwen2/Qwen3の組合せをサービスで検証。training/finetuningも同じCodeVersion契約を使う。
- `GET|POST /projects/:p/datasets` (name,namespace?,description?) / `GET|POST /projects/:p/datasets/:id/versions` (version,uri,digest,schema?,metadata?,sourceRunId?,parentDatasetVersionIds?,externalRef?)。sourceRunIdがあればRun.outputへ関係を保存。
- `GET /projects/:p/lineage` → LineageGraph。
- `GET|POST /targets` (ComputeTargetのidを除く。作成はglobal admin)。取得時に鍵パス等を一般viewerへ出さない。executor=localはdevelopmentの明示許可のみ。
- `GET /projects/:p/jobs` / `POST /projects/:p/jobs` (runId,targetId,gpuIds?,maxAttempts?)。Run kindとCodeVersion taskTypes、モデル系列、GPU一覧、参照projectを検証。
- `POST /projects/:p/jobs/:j/cancel` / `POST /projects/:p/jobs/:j/retry`。retryは新Run/Jobを作り`{run,job}`。生きているleaseのGPUを解放しない。
- `GET|POST /tokens` (POST:name,kind,projectId,scopes,expiresAt?; `{token:string,item:TokenSummary}`一度だけ返す)。`DELETE /tokens/:id`。tokenはhashのみ保存。scope候補は`read`,`runs:write`,`registry:write`,`artifacts:write`,`jobs:write`,`worker:execute`,`admin`。worker tokenは設定されたprojectのみclaim可能。
- `GET|POST /projects/:p/plugins` (POST:name,baseUrl,tokenEnv,enabled?)。登録は全体管理者に限定し、plugin secretは環境変数参照。Project adminは登録済みのpluginを利用する。`POST /projects/:p/plugins/:id/check` → manifest。`POST /projects/:p/plugins/:id/datasets/search` ({query}) → `{items:PluginDataset[]}`。
- `POST /projects/:p/plugins/:id/datasets/import` ({dataset:PluginDataset}) → DatasetVersion。`POST /projects/:p/plugins/:id/events/retry` → `{queued:number}`。`GET /projects/:p/plugins/:id/metrics` → `{prometheus:string}`（storage:metrics対応pluginのみ）。event outboxはRun状態のtransactionと一緒に保存し、plugin障害でRunを失敗させない。

## Worker API

- `POST /worker/claim` ({workerId,targetIds?:string[],activeJobIds?:string[]}) → `{item:WorkerJob|null}`。DB transaction＋SKIP LOCKED、target/GPU予約、worker project scope、ランダムleaseを使う。activeJobIdsは既に監視中のJobを指定する。そのID以外に同じworkerの未完了Jobがあれば同じleaseで回収し、なければ次をclaimする。同じpayloadの再送で新たなJobを重複claimしない。
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
