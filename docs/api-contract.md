# API契約 v0.1

本体はTypeScript/Hono＋PostgreSQL、React/Vite、Python worker/SDK。Mado pluginは別リポジトリのHTTP service。JSONはcamelCase。成功時はentityを直接返す。一覧は`{items: T[]}`。エラーは`{error:string,code?:string}`で適切な4xx/5xx。IDはUUID、日時はISO UTC。版とRunの参照は不変。外部のサンプルを自動で本番へseedしない。

## Web/SDK

prefix `/api`。WebはHttpOnly session cookie、SDKはBearer token。Cookieによる変更はOrigin検証。viewer=読む、editor=実験/登録/実行、admin=project設定/メンバー/token/plugin。API tokenはscopeとproject membershipを両方確認する。

Originは`MMT_WEB_ORIGIN`/`MMT_PUBLIC_URL`の完全一致を許可し、`MMT_ALLOW_PRIVATE_ORIGINS=true`ならHTTP(S)のprivate/local/VPN IPとlocalhostも許可する。CORS・開発login/logout・sessionの変更で同じ判定を使う。設定省略時はfalse。null/欠落や未許可のOriginはsession変更操作で403 `invalid_origin`。BearerリクエストはOrigin不要。許可範囲とSSOの固定callbackは[運用手順](operations.md)を参照する。

- `GET /health` → `{status:'ok'}`。DB障害は503。
- `GET /auth/config` → AuthConfig `{mode,methods:{local,oidc:{label,loginUrl}|null}}`。modeは`local`/`oidc`/`hybrid`/`development`。`methods.local`はローカルアカウントのloginを受け付けるか、`methods.oidc`はSSOの表示名と開始URL。`GET /auth/me` → AuthMe `{user:User,mustChangePassword:boolean}` (未認証401)。`POST /auth/dev-login` → `{user}`はdevelopment modeだけ。`GET /auth/login` / `GET /auth/callback` / `POST /auth/logout`。
- Userは`username:string|null`（ローカルアカウントのlogin名。SSOのみはnull）、`status:'active'|'disabled'`、`authSources:('local'|'oidc')[]`を持つ。無効化したUserはsession・API tokenとも401。Userは物理削除しない。
- `POST /auth/local-login` ({username,password}) → AuthMe、session cookieを発行する。`methods.local=false`なら404 `local_login_disabled`。Origin検証はdev-loginと同じ。存在しないusername・誤ったpassword・無効化Userは区別せず401 `invalid_credentials`。passwordはArgon2idで照合する。usernameと接続元の失敗回数を制限し、超過は429 `rate_limited`と`Retry-After`秒を返す。
- `POST /auth/change-password` ({currentPassword,newPassword}) → 204。sessionのローカルアカウントだけが使える。API tokenなどsession以外は403 `session_required`、local credentialの無いUser（SSOのみ）は403 `local_account_required`。現在のpasswordが誤りなら401 `invalid_credentials`、新しいpasswordが条件（12〜1024 byte、現在と異なる）を満たさなければ422 `weak_password`。現在のpasswordの確認はUserごとに回数を制限し、超過は429 `rate_limited`。照合中に同じUserのpasswordが別の要求で変わった場合は409 `password_changed_concurrently`で、変更しない。変更後は呼び出し元のsessionを残し、同じUserのほかのsessionを失効させる。
- Web sessionはidle期限（`AUTH_SESSION_IDLE_SECONDS`、既定8時間）とabsolute期限（`AUTH_SESSION_ABSOLUTE_SECONDS`、既定12時間）の早い方で失効し、以後は401。cookieのmaxAgeはabsolute期限。logoutはsessionを失効させる。
- `mustChangePassword=true`のsession（初期管理者・管理者による再設定直後）は、`GET /auth/config`・`GET /auth/me`・`POST /auth/change-password`・`POST /auth/logout`以外を403 `password_change_required`で拒否する。
- `GET /projects` / `POST /projects` (name,description?,artifactBackend?) / `PATCH /projects/:id` (description?,artifactBackend?)。
- `GET /projects/:p/members` / `PUT /projects/:p/members/:userId` (role)。管理者以外は権限変更不可。
- `GET|POST /projects/:p/experiments` (name,description?)。
- `GET /projects/:p/runs?experimentId=&status=&q=&limit=` / `POST /projects/:p/runs` (experimentId,name,kind,parameters?,tags?,modelVersionId?,codeVersionId?,inputDatasetVersionIds?,parentRunId?,environment?,executionMode?)。
- `GET|PATCH /projects/:p/runs/:r` (PATCH:name?,parameters?,tags?,status?,environment?; job紐付きの状態はworkerが管理)。parametersはキー単位merge。job実行開始後は実行設定の変更を拒否する。CodeVersionがあるRunは`environment.runtime`に実際のruntimeを固定し、environmentの置換でも維持する。異なるruntimeへの変更は拒否する。再実行は新しいRun。
- `GET|POST /projects/:p/runs/:r/metrics` (POST:{metrics:MetricPoint[]})。
- `GET|POST /projects/:p/runs/:r/logs` (POST:{entries:LogEntry[]})。
- `GET /projects/:p/runs/:r/artifacts` / `PUT /projects/:p/runs/:r/artifacts?path=` (raw binary、Content-Type; Artifactを返す)。Run無しの登録は`PUT /projects/:p/artifacts?path=`。
- `GET /projects/:p/artifacts?query=&limit=` → `{items:Artifact[]}`。Projectの保存済みArtifact一覧で、limitは既定100、最大500。`GET /projects/:p/artifacts/:a` → Artifactのmetadata。viewer/readで参照でき、保存先のblobは読み込まない。
- `GET /projects/:p/artifacts/:a/content` (Range対応。危険なHTML/SVG等はattachment)。Artifactは不変なので、応答に強いETag `"sha256-<hex>"`と`Cache-Control: private, max-age=31536000, immutable`を付ける（API共通の`no-store`を上書きする）。`If-None-Match`が一致すれば本文なしの304。Rangeの206にも同じETagを付け、`If-Range`が一致しなければ全体を200で返す。
- Artifactのupload（native・MLflowとも）は1件`MMT_ARTIFACT_MAX_BYTES`（既定200GiB）まで。Content-Lengthが上限を超える場合は読み込まずに、chunk転送で途中から超えた場合は書きかけのblobを消して、413 `artifact_too_large`を返す（MLflow経路は`RESOURCE_EXHAUSTED`）。uploadはrequest全体のtimeout（`MMT_UPLOAD_REQUEST_TIMEOUT_MS`、既定0=無効）と無通信timeout（`MMT_UPLOAD_IDLE_TIMEOUT_MS`、既定120000）で打ち切る。`GET /storage/backends` → `{items:('filesystem'|'s3')[]}`。
- `GET|POST /projects/:p/models` (name,family,description?)。`GET /projects/:p/models?name=`はnameの完全一致で絞り込み、`{items:Model[]}`（0件または1件）を返す。既存系列を再利用するSDKの登録で使う。
- `GET|POST /projects/:p/models/:id/versions` (ModelVersionCreate: version?,parentModelVersionIds?,sourceRunId?,weightsUri?,artifactId?,defaultCodeVersionId?,metadata?)。versionを省略すると、Modelごとの番号（初回は`1`）をAPIが採番する。番号はMLflowのCreateModelVersionと共有し、削除した版の番号は再利用しない。明示した整数のversionで登録すると、次の番号はその版の次まで進む。整数でない版と19桁以上の数字は採番の計算から除外する。採番はModelの行lockで直列化し、同時登録でも重複しない。明示したversionの重複は409。
- sourceRunIdを指定する場合、Runは同じProject（別Projectは404）で、kindが`training`または`finetuning`であることを検証する。それ以外のkindは422 `output_model_kind`、削除済みのRunは422 `source_run_deleted`。Runの`outputModelVersionIds`は、そのRunをsourceRunIdに持つModelVersionのIDを登録順に返す（MLflowで削除した版は除く）。Runを返すすべての応答（作成・取得・PATCH・一覧・Task履歴・retry・Task起動）とplugin eventの`run`にこのfieldが付く。Runを終端にする遷移はRunを行lockし、同じRunへの出力登録と直列化する。終端後に登録した版は、終端eventを版入りで再送する。
- `PUT /projects/:p/models/:id/aliases/:alias` ({versionId})。実行時はaliasではなく実際のModelVersion IDをRunへ保存。
- `GET|POST /projects/:p/codes` (name,description?) / `GET|POST /projects/:p/codes/:id/versions` (version,source?,runtime?,entrypoint,testEntrypoint?,requirements?,environment?,supportedModelFamilies,taskTypes)。source/runtime/entrypointは下記とcontracts参照。Qwen2/Qwen3の組合せをサービスで検証。training/finetuningも同じCodeVersion契約を使う。
- `GET|POST /projects/:p/datasets` (name,namespace?,description?) / `GET|POST /projects/:p/datasets/:id/versions` (version,uri,digest,schema?,metadata?,sourceRunId?,parentDatasetVersionIds?,externalRef?)。sourceRunIdがあればRun.outputへ関係を保存。
- `GET /projects/:p/lineage` → LineageGraph。
- `GET|POST /targets` (ComputeTargetのidを除く。作成はglobal admin)。`runtimeKinds`は重複のないPython/Docker/Singularity/Apptainerの一覧で、省略時は`['python']`。取得時に鍵パス等を一般viewerへ出さない。executor=localはdevelopmentの明示許可のみ。
- `PATCH /targets/:id` → ComputeTarget。全体管理者が設定・有効状態を変更する。queued/claimed/runningのJobが参照中なら接続先・Runtime・GPU等の変更を409で拒否する。有効切替は可能で、無効targetは新規claimの候補から外す。実行中Jobのleaseを取り消さない。
- `GET /projects/:p/jobs` / `POST /projects/:p/jobs` (runId,targetId,gpuIds?,maxAttempts?)。Run kindとCodeVersion taskTypes、モデル系列、固定runtimeとtargetの対応runtime、GPU一覧、参照projectを検証。
- `POST /projects/:p/jobs/:j/cancel` / `POST /projects/:p/jobs/:j/retry`。retryは新Run/Jobを作り`{run,job}`。生きているleaseのGPUを解放しない。
- `GET|POST /tokens` (POST:name,kind,projectId,scopes,expiresAt?; `{token:string,item:TokenSummary}`一度だけ返す)。`DELETE /tokens/:id`。tokenはhashのみ保存。scope候補は`read`,`runs:write`,`registry:write`,`artifacts:write`,`jobs:write`,`worker:execute`,`admin`。worker tokenは設定されたprojectのみclaim可能。
- `GET|POST /projects/:p/plugins` (POST:name,baseUrl,tokenEnv,enabled?)。登録は全体管理者に限定し、plugin secretは環境変数参照。Project adminは登録済みのpluginを利用する。`POST /projects/:p/plugins/:id/check` → manifest。`POST /projects/:p/plugins/:id/datasets/search` ({query}) → `{items:PluginDataset[]}`。
- `PATCH /projects/:p/plugins/:id` (name?,baseUrl?,tokenEnv?,enabled?) → PluginConnection。変更も全体管理者に限定する。接続設定を変えると保存済みmanifestを消し、再確認を要求する。確認中に設定が変わった場合は古いmanifestを保存しない。無効pluginへはoutboxを送らず、再び有効にすると配信を再開する。
- `POST /projects/:p/plugins/:id/datasets/import` ({dataset:PluginDataset}) → DatasetVersion。`POST /projects/:p/plugins/:id/events/retry` → `{queued:number}`。`GET /projects/:p/plugins/:id/metrics` → `{prometheus:string}`（storage:metrics対応pluginのみ）。event outboxはRun状態のtransactionと一緒に保存し、plugin障害でRunを失敗させない。

## Task・コード編集・テスト実行

- `GET|POST /projects/:p/tasks`。POSTは`experimentId,name,description?,kind,codeVersionId,modelVersionId?,inputDatasetVersionIds?,parameters?,tags?,targetId?,gpuIds?`。参照は同じProjectに限定し、コードの実行種別・モデル系列・Runtime・GPUを検証する。
- `GET|PATCH /projects/:p/tasks/:id`。PATCHは`expectedRevision`と変更する設定を送る。Experimentは変更しない。保存時にrevisionを増やし、競合は409。登録・編集はeditorと`registry:write`を要求する。
- `POST /projects/:p/tasks/:id/launch` ({expectedRevision,executionMode,targetId?,gpuIds?,name?,parameters?,modelVersionId?,inputDatasetVersionIds?}) → `{run,job}`、201。editorに`runs:write`と`jobs:write`を要求する。Taskの指定revisionを固定し、RunとJobを同じtransactionで作る。parametersはキー単位merge、GPUと入力Datasetの配列は置換。古いrevisionならRun/Jobを作らず409を返す。
- Taskの`outputModel`（成功時に出力モデルを登録）は`{modelId,createModel,artifactPath,versionTemplate?,defaultCodeVersionId?,metadata?}|null`。`modelId`（同じProjectのModel、別Projectは404）と`createModel:{name,family}`はどちらか一方だけを指定する。kindが`training`/`finetuning`以外なら422 `output_model_kind`（kindをinferenceへ変えるPATCHも同じ）。Modelの系列、`createModel.family`、`defaultCodeVersionId`の対応系列がTaskのCodeVersionの`supportedModelFamilies`に無ければ422 `incompatible_model_family`。`createModel`と同じ名前のModelが別の系列で既にあれば422 `model_family_mismatch`。`artifactPath`はRun Artifactのファイルの相対パス（絶対パス・`..`・末尾`/`は422 `invalid_request`。workerの出力は`container/<path>`）。`versionTemplate`は`{runId}`・`{runName}`・`{taskRevision}`の少なくとも1つを含む版名で、省略時は整数で自動採番する。Taskの`tags`に予約tag（`automation.`・`mmt.`で始まるkey）があれば422 `reserved_tag`。
- 起動時（`executionMode=run`）にTaskの`outputModel`をRunの`outputModelRegistration`へ複写する。再実行（Job retry）は前のRunの複写を引き継ぐ。テスト実行では複写しない。複写した設定は変更できず、Run作成後にTaskを編集しても変わらない。
- Runが`finished`になった遷移の中で、Task側の登録を1回だけ行う（`failed`/`canceled`では行わない）。そのRunをsourceRunIdとする版が登録先と同じModelに既にあれば（学習コード内のSDK`register_output_model`やMLflow`log_model(registered_model_name=…)`）、Task側は登録せず`skipped`（reason `already_registered_by_run`、`modelVersionId`は既存の版）にする。下流の自動実行は既存の版から1回だけ起動する。別のModelへの登録はTask側の登録を妨げない。`createModel`は同じ名前のModelを再利用し、無ければ作る。Artifactは`artifactPath`と同じpathの最新の1件を使う。登録はRunの作成者として行い（現在のeditor以上の所属を再確認）、`sourceRunId`=Run、親版=Runの`modelVersionId`。登録した版は通常の登録と同じく自動実行を起動する。
- 失敗してもRunは`finished`のまま残し、`failed`と理由のcodeを記録する: `artifact_not_found`、`model_not_found`、`model_deleted`（MLflowで削除したModel）、`model_family_mismatch`、`invalid_version`（描画した版名が不正）、`version_conflict`（同じ版名が既にある）、`creator_access_revoked`、`registration_failed`。失敗した試みで作ったModelは残らない。同じRunの2回目の終端（MLflowで再開したRunなど）では登録し直さない。
- `GET /projects/:p/runs/:r/output-registration` → `RunOutputRegistration {status:'registered'|'failed'|'skipped', modelVersionId, error, reason}`。viewerと`read`を要求する。記録が無ければ404 `output_registration_not_found`（出力設定が無いRun、終端前、`failed`/`canceled`で終わったRun）。Run詳細にはこの結果を付けず、Runの`outputModelRegistration`で設定の有無を返す。
- `GET /projects/:p/tasks/:id/runs?limit=&cursor=` → `{items:Run[],nextCursor:string|null}`。以前のrevisionを含むactiveな実行履歴を返す。limitは既定50、最大200。cursorには前ページ末尾のRun IDを指定する。同じProjectとTaskのRunだけを境界に使い、作成日時とIDで古い実行へ進む。
- `POST /projects/:p/repository-files` ({url,commit}) → `{commit,files,omittedPaths}`。editorと`registry:write`を要求する。完全なcommit hashを照合し、テキストを制限内で返す。URLの認証情報・不正protocol・symlink・危険なパスを拒否する。既存Git設定や認証情報を引き継がず、SSHはAPI server側の明示設定を使う。

Git sourceは`{kind:'git',url,commit,files?,deletedFiles?}`。`files`は編集ファイル、`deletedFiles`は固定commitから削除する相対パス。`.git`、絶対パス、`..`、重複・編集と削除の衝突を拒否する。Inline sourceも同じパス・サイズ検証を使う。既存のArtifact sourceとsourceなしコンテナを維持する。

`executionMode`は`run`または`test`。省略時は`run`。コード版のあるRunにはAPIが`executionSnapshot`を保存し、クライアントからの指定・上書きを認めない。コード版ID・version・source・Runtime・実行コマンド・依存関係・環境設定を固定する。テストは空でない`testEntrypoint`を要求する。Runの`taskId`と`taskRevision`も固定し、再実行はこれらと実行モードを引き継ぐ。MLflow経路もDB triggerで同じsnapshotを保存する。

通常のRun一覧とTask履歴は、SQLで`executionSnapshot`を読み込まず概要だけを返す。コード全文と環境設定はRun詳細とworkerのclaim/resumeで取得する。MLflowで削除したRunは通常の履歴から除外し、復元すると再表示する。

workerは実行前のソースを`.mmt/source.zip`と`.mmt/source-manifest.json`へ保存し、RunのArtifactsへアップロードする。sourceなしコンテナはmanifestだけ。manifestにはJobごとのファイルhashを記録する。外部pluginのeventにはコード本文と環境設定を持つ`executionSnapshot`を含めない。

## MLflow 3互換API

接続先は`/api/mlflow/projects/:p`。公式SDKの`MLFLOW_TRACKING_URI`と`MLFLOW_REGISTRY_URI`へこのURLを指定する。`:p`はProjectのUUIDで、既存API tokenのProject制限・現在のmembership・scopeを要求する。互換APIはMLflowのsnake_case JSONとint64の文字列表現を使い、エラーを`{error_code,message}`で返す。

- `/api/2.0/mlflow/experiments/*`、`/runs/*`：Experiment/Runの作成・取得・検索・tags・softdelete/restore、params・metric履歴・batch、Runの入出力Dataset/Logged Model。新規Datasetの登録には`runs:write`と`registry:write`が必要。
- `/api/2.0/mlflow/logged-models/*`：MLflow 3のモデルID、params/tags、PENDING/READY/FAILEDとモデルmetrics。READY確定は保存済みArtifactと`MLmodel`の参照を検証する。
- `/api/2.0/mlflow/registered-models/*`、`/model-versions/*`：native Model/ModelVersionを使った登録、数字版の採番、検索、tags、alias。登録とモデル自動実行を同じtransactionへ保存する。
- `GET /api/2.0/mlflow/artifacts/list`、Logged ModelのArtifacts一覧、`GET|PUT /api/2.0/mlflow-artifacts/artifacts/*`：Projectのfilesystem/S3へstream転送。SDKにストレージの秘密を渡さず、Rangeに対応する。
- `GET /server-info`：SDKへの転送capabilityを返す。SDK向けmultipartはfalseで、通常のstream転送を使う。
- `POST /api/2.0/mlflow/registered-models/get-latest-versions` ({name,stages?})：stageごと（`transition-stage`で設定した`current_stage`。既定は`None`）に最新の版を1件ずつ返す。`stages`を指定するとそのstageだけを返す。削除した版は含めない。GETは提供しない（公式SDKはPOSTから試すので使える）。
- `POST /api/2.0/mlflow-artifacts/mpu/create|complete|abort/*`：multipart uploadは未対応。501 `NOT_IMPLEMENTED`を返し、SDKを通常のstream転送へ戻す。SDKはmessageの先頭が自身の定数（`Multipart upload is not supported for the current artifact repository`）と一致するときだけ戻るので、messageはこの英語の文言で固定する。未認証は401。

Artifactのroot URIは`mlflow-artifacts:/runs/:runId/artifacts`または`mlflow-artifacts:/models/:loggedModelId/artifacts`。登録したモデル版の取得先は`mlflow-artifacts:/model-versions/:nativeVersionId/artifacts`で、版の不変manifestから全ファイルを解決する。元Runのpath上書きやLogged Modelの削除で保存済み版を変更しない。

JobのあるRunの開始・終了状態はworkerが正本。SDKのstart/end操作は状態を変更せず受け付ける。SDKが追加するparamsは`recordedParameters`へ保存し、Jobの起動・再接続に使う`parameters`を変更しない。SDKとWebの表示・検索は両方を合成する。通常のMLflow Runのparamsはstringで不変。

MLflow 3の実験記録・モデル保存/登録を対象とし、Tracing/GenAI/Gateway/Prompt Registryは対象外。未知の検索構文とAPIは明示エラーを返す。接続と検証の例は[MLflow手順](mlflow.md)を参照する。

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

## 監査ログ

認証・Project・token・権限などの操作を`audit_events`へ記録する。AuditEventは`{id,occurredAt,actorType:'user'|'token'|'system',actorUserId,actorTokenId,action,outcome:'success'|'denied'|'failed',resourceType,resourceId,projectId,details,ip,userAgent}`。成功の記録は業務と同じtransactionでINSERTし、業務がrollbackすれば記録も残らない。拒否・失敗の記録は業務のtransactionの外で書く。`details`へpassword・token・secretの値を入れない。`ip`はAPIが受けたsocketの接続元で、転送ヘッダーは信頼しない。

- `GET /audit-events?projectId=&action=&actorUserId=&outcome=&limit=&cursor=` → AuditEventPage `{items:AuditEvent[],nextCursor:string|null}`。全体管理者のsessionだけ。API tokenはProject制限の有無にかかわらず403 `session_required`。Projectに属さない記録（`projectId=null`。認証など）もここで読める。
- `GET /projects/:p/audit-events?action=&actorUserId=&outcome=&limit=&cursor=` → 同じ形。Project admin（API tokenは`admin` scopeとProject制限・membershipも要求）。
- 新しい順（occurredAt、idの降順）。limitは既定50、最大200。cursorは前ページ末尾のAuditEvent ID。存在しないcursor、または別Project・絞り込みの対象外のcursorは404。
- 拒否の記録は権限不足（403）と競合（409）だけで、`outcome='denied'`と`details.code`（APIのerror code）を持つ。入力検証エラーや存在しない対象は記録しない。
- action: `auth.login`（details.method=`local`/`oidc`/`development`。失敗は`outcome='failed'`、actorは`system`）、`auth.logout`、`auth.password.change`、`auth.bootstrap_admin`（端末の`bootstrap-admin`で初期管理者を作成・再設定）、`project.member.set`（旧role/新role）、`token.create`（name、kind、scopes、expiresAt）、`token.revoke`。回数制限で429にした試行は記録しない。
- 記録は無期限に保存する。削除・変更のAPIはなく、DBでもUPDATE/DELETEを拒否する。

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
