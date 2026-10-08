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
- SSOのlogin（`GET /auth/callback`）はAuthentikのgroupで許可と全体roleを決める。`OIDC_ALLOWED_GROUPS`（カンマ区切り、`oidc`/`hybrid`で必須。空なら起動しない）のどれにも入っていないUserは拒否し、Userを作らない。全体roleは`admin`（全体管理者、`User.isAdmin`）と`user`（loginのみ）で、`OIDC_ROLE_MAPPING_JSON`（`{"<group>":"admin"|"user"}`。未知のroleは起動時エラー）で決める。複数groupに該当すれば強い方、どれにも該当しなければ`OIDC_DEFAULT_ROLE`（既定`user`）。`OIDC_ADMIN_GROUP`は`{"<group>":"admin"}`の省略形で、両方を指定してadminのgroupが食い違えば起動しない。どちらも無ければ`mmt-admins`をadminとする。loginのたびに`isAdmin`とUserのgroupを同期する。拒否（groupが無い、`email_verified`がtrueでない、無効化したUser、最後の有効な全体管理者を外す同期、特権を持つLocal Userへのemail自動連携）は利用者には区別せず401 `oidc_authentication_failed`で、理由は監査ログの`auth.oidc.denied`の`details.reason`（`group_not_allowed`/`email_not_verified`/`user_disabled`/`last_admin`/`privileged_link_required`）に残す。同じemailのLocal Userへの自動連携は`OIDC_AUTO_LINK_VERIFIED_EMAIL=true`のときだけ行う（既定false）。要求するscopeは`OIDC_SCOPES`（既定`openid profile email`、`openid`必須）。
- Web sessionはidle期限（`AUTH_SESSION_IDLE_SECONDS`、既定8時間）とabsolute期限（`AUTH_SESSION_ABSOLUTE_SECONDS`、既定12時間）の早い方で失効し、以後は401。cookieのmaxAgeはabsolute期限。logoutはsessionを失効させる。
- `mustChangePassword=true`のsession（初期管理者・管理者による再設定直後）は、`GET /auth/config`・`GET /auth/me`・`POST /auth/change-password`・`POST /auth/logout`以外を403 `password_change_required`で拒否する。
- `GET /projects` / `POST /projects` (name,description?,artifactBackend?) / `PATCH /projects/:id` (description?,artifactBackend?)。
- `GET /projects/:p/members` / `PUT /projects/:p/members/:userId` (role)。管理者以外は権限変更不可。
- `GET|POST /projects/:p/experiments` (name,description?)。
- `GET /projects/:p/runs?experimentId=&status=&q=&limit=` / `POST /projects/:p/runs` (experimentId,name,kind,parameters?,tags?,modelVersionId?,codeVersionId?,inputDatasetVersionIds?,parentRunId?,environment?,executionMode?)。
- `POST /projects/:p/runs/search` body `RunSearchRequest` {experimentIds?,filter?,orderBy?,kinds?,statuses?,modelVersionIds?,inputDatasetVersionIds?,parentRunId?,name?,limit?,cursor?} → `RunSearchPage` {items:Run[],nextCursor:string|null}。activeなRunの全履歴をサーバー側で検索する。viewer以上と`read` scope。filter（最大2000文字）とorderBy（最大5件、各500文字）はMLflow `runs/search`と同じ構文・同じcompilerで、paramsは実行parametersとSDKの記録値を合成し（記録値が優先）、metricsは最新値で比べる。並べ替えのNaNと欠損はMLflowと同じく数値の後ろ。構文・未対応の属性は400 `invalid_parameter_value`、上限を超えた入力は422 `invalid_request`。nameは名前の部分一致（大文字小文字を区別しない、`%`と`_`は文字どおり）。配列の条件は空なら絞らない。他Projectのexperimentは404。limitは既定100、最大500。itemsは一覧と同じ概要でexecutionSnapshotを含まない。orderBy無しは作成日時・IDの新しい順で、cursorは前ページ末尾のRun（keyset）なので、ページ送り中に作られたRunで後のページはずれない。orderBy有りは条件付きのoffset cursor。cursorは検索条件（limitを除く）に結び付き、条件を変えたcursorや不正なcursorは400 `invalid_cursor`。`GET /projects/:p/runs`は互換のため残す。
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
- `PUT /projects/:p/models/:id/aliases/:alias` ({versionId, reason?}) → Model。実行時はaliasではなく実際のModelVersion IDをRunへ保存。reasonは任意で最大2000文字。`DELETE /projects/:p/models/:id/aliases/:alias`（bodyは省略可、{reason?}）→ 204。未設定のaliasは404。変更はeditor+`registry:write`、別Projectのmodel IDとversionは404。
- `GET /projects/:p/models/:id/alias-events?alias=&limit=&cursor=` → `{items:ModelAliasEvent[], nextCursor}`（viewer+read。新しい順、limitは既定50・最大200、cursorは前ページ最後のevent id。別Modelのcursorは404）。alias変更はすべてappend-onlyの`model_alias_events`に1件ずつ残る（UPDATE/DELETEはDBで拒否）。versionIdがnullなら解除、previousVersionIdがnullなら初回設定。同じ版への再設定はeventを増やさない（MLflow SDKの再送対策）。sourceはnativeのbrowser sessionが`web`、API tokenが`api`、MLflow互換の設定・解除が`mlflow`（reasonは空）、MLflowのModelVersion削除・Registered Model削除で外れたaliasが`version_deleted`・`model_deleted`、`promotion_policy`は昇格ポリシー用に予約。actorは操作したユーザーとtoken（無い場合はnull。移行時点の既存aliasは`source='api'`、`reason='migration snapshot'`、actor nullの初期eventになる）。同じModelのalias変更はModelの行lockで直列化し、previousVersionIdは直前のeventの版と必ず連鎖する。
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

## Runの予約tagと終端後の記録

- 予約tag: `automation.`と`mmt.`で始まるRunのtagはサーバーが付ける（例: 自動実行の`automation.ruleId`）。利用者はnative・MLflowのどちらからも付け外しできない。対象はnativeの`POST /projects/:p/runs`と`PATCH /projects/:p/runs/:r`のtags（422 `reserved_tag`）、MLflowの`runs/create`のtags、`runs/set-tag`、`runs/delete-tag`、`runs/log-batch`のtags（400 `INVALID_PARAMETER_VALUE`）。`mlflow.`で始まるsystem tagは従来どおり書ける。予約tagを持つ既存Runはそのまま残す。自動化の判定はtagではなく`model_automation_executions.run_id`で行う。
- 終端後の記録: Jobが付いたRunが終端（finished/failed/canceled）になった後は、metrics・params・tags・Dataset入力への書き込みを409 `run_finalized`で拒否する（MLflowは`INVALID_STATE`）。対象はnativeの`POST /runs/:r/metrics`とPATCHのtags/parameters、MLflowの`log-metric`、`log-parameter`、`log-batch`、`set-tag`、`delete-tag`、`log-inputs`、`runs/outputs`、`log-model`。名前の変更、logs、MLflowの`runs/update`（状態はworkerが正本のまま）とsoftdelete/restoreは受け付ける。Jobが付かないRunはMLflowと同じく終端後も書ける。

## コンテナのCodeVersion

`runtime`は省略時に`{kind:'python'}`へ正規化する。既存CodeVersionとtargetもmigrationでPythonへ移行する。版はruntimeを含めて更新不可。

- Python: `{kind:'python'}`。Gitの固定commit、inline files、保存済みArtifactのいずれかの`source`が必須。
- Docker: `{kind:'docker',image,workingDirectory?}`。imageは`repository[:tag]@sha256:<64桁の小文字hex>`へ固定する。registry/portを含むreferenceも登録できる。APIはregistryに接続しない。
- Singularity/Apptainer: `{kind:'singularity'|'apptainer',artifactId,sha256,workingDirectory?}`。保存完了済みArtifactを同じProjectで照合し、SHA256の完全一致を確認する。Job登録とworker claimでも再確認する。

コンテナは`source`を省略またはnullにでき、任意のGit/inline/Artifact sourceも追加できる。Artifact sourceも同じProjectに限定する。コンテナの`requirements`は空にする。pip依存の指定はPythonで使う。`entrypoint`は空でないargv配列で、NULを含む引数は拒否する。`workingDirectory`はコンテナ内の絶対パスで、`..`などの脱出を拒否する。未知のruntimeフィールド、系列/taskTypesの重複も拒否する。hostのsupervisor用Pythonはtargetの`pythonExecutable`を引き続き使う。

Runは固定CodeVersion IDと`environment.runtime`を保存する。Job登録時とworker claim時に固定内容が一致することを確認し、targetが対応しないruntimeのJobは実行しない。

## モデル登録後の自動実行

- `GET /projects/:p/automation-rules` → `{items:ModelAutomationRule[]}`。
- `POST /projects/:p/automation-rules` → ModelAutomationRule、201。bodyは`name,modelFamilies,kind,experimentId,codeVersionId,targetId,trigger?,upstreamRuleId?,gpuIds?,inputDatasetVersionIds?,parameters?,tags?,maxAttempts?,enabled?`。`kind`は`inference`・`evaluation`・`processing`。`trigger`は`model_registered`（既定）または`upstream_run_finished`（下記の連鎖）。`enabled`はtrue、GPU/入力は空、parameters/tagsは空、maxAttemptsは3が既定。
- `PATCH /projects/:p/automation-rules/:id` ({enabled:boolean}) → ModelAutomationRule。設定は不変で、有効/無効だけを切り替える。設定変更は新しいruleを登録する。
- `GET /projects/:p/automation-executions` → `{items:ModelAutomationExecution[]}`。最新100件を返す。保留中の登録（下記）も`status:'pending'`の行として含める。
- `POST /projects/:p/automation-rules/:id/executions` ({modelVersionId}|{triggerRunId}) → ModelAutomationExecution、201。既存の版への手動適用（下記）。

作成・切替はProject adminまたはglobal adminだけが行える。API tokenには`admin` scopeに加え、Project制限と現在のmembershipを要求する。読む操作はviewerと`read` scope。CodeVersion、Experiment、入力DatasetVersionは同じProjectで照合し、モデル系列/kind、targetの有効状態/runtime/GPUも登録時に検証する。ruleには`createdBy`を保存する。登録処理では作成者の現在のProject admin/global admin権限を再確認し、失効していれば`skipped`を記録する。

ModelVersion登録のtransaction内で、同じ系列の有効ruleを判定し、共通のRun/Job登録処理を使って自動実行をqueueへ追加する。SDKのモデル出力登録もこの経路を通る。保存済み重みArtifactをProjectで照合する。`weightsUri`の実体はworkerが取得確認し、APIからはfetchしない。重みが指定されていなければ`skipped`を記録する。Artifact uploadだけでは起動しない。

登録イベントは`model_automation_events`で一度だけ処理し、executionにも登録起動（`trigger_run_id IS NULL`かつ`source='automatic'`）に限る部分unique`(rule_id,model_version_id,attempt)`を設ける。モデル登録と同じtransactionなので外側のrollbackではRun/Job/イベントも残らない。各ruleの失敗はsavepointでRun/Jobをrollbackして`failed`と安全なerror文字列を保存し、ほかのruleとModelVersion登録を残す。設定が変わったtargetや不正な参照もここで再検証する。過去モデル、disabled中の登録、有効ruleがない登録へは遡及しない。失敗・skipした登録イベントの再送でも自動実行を増やさない。

自動Runはruleの固定CodeVersion/設定を使い、`sourceRunId`を`parentRunId`へ関連付ける。`tags['automation.ruleId']`と`environment.automationRuleId`にrule ID、`environment.runtime`に固定runtimeを保存する。executionの`status`は登録時の結果（queued/failed/skipped）で、実行後も変わらない。`runStatus`と`jobStatus`で現在の実行状態を返し、Run/Jobを作らなかった場合はnullになる。

自動実行の起動時点は、版の`sourceRunId`が指すRunの状態で決まる。生成元Runがない、または登録時点で終端（finished/failed/canceled）なら登録のtransactionで即時に処理する。終端でなければ`model_automation_events.state='pending'`で保留し、そのRunの終端遷移（RunCompletionServiceのterminal handler `AutomationSourceRunHandler`。出力登録handlerの後）で処理する。finishedなら終端時点で有効なruleを従来と同じ方法で実行し`processed`へ、failed/canceledなら有効な各ruleに`skipped`・error`source_run_unsuccessful: …`を残して`source_unsuccessful`へ。保留から7日（`AUTOMATION_PENDING_MAX_AGE_HOURS=168`）を超えたもの、または生成元Runがsoft-deleteされたものは、API内のsweeper（10分ごと、`pg_try_advisory_xact_lock`で1 processだけ）が有効な各ruleに`skipped`・error`source_run_timeout: …`を残して`source_timeout`へ。閉じた保留は、その後に生成元Runが成功しても起動しない。handlerは保留中のeventだけを`FOR UPDATE`で処理するので、終端通知の再送やMLflowの再開（FINISHED→RUNNING→FINISHED）でも1回だけ起動する。

ModelAutomationExecutionは`sourceRunId`（版の生成元Run、なければnull）を持つ。`status:'pending'`の行は保存されたexecutionではなく、保留中の版について現在有効な同系列ruleごとに1行を返す（`runId`/`jobId`/`error`/`runStatus`/`jobStatus`はnull、`createdAt`は保留の開始時刻、`id`は版とruleから決まる値）。終端後は保存されたexecutionに置き換わる。

### 自動実行の連鎖と既存版への手動適用

- `trigger:'upstream_run_finished'`のruleは`upstreamRuleId`（同じProjectのrule）が必須で、`model_registered`のruleには指定できない（どちらも422 `invalid_automation_trigger`）。上流ruleが別Projectまたは存在しなければ404、無効なら422 `upstream_rule_disabled`。連鎖は登録起動のruleを1段目として`MAX_AUTOMATION_CHAIN_DEPTH=5`段まで（超えると422 `automation_chain_too_deep`）。ruleは不変で上流は作成前に存在するので循環は作れないが、検出時は422 `automation_chain_cycle`。`trigger`と`upstreamRuleId`も不変。
- 上流の特定は`model_automation_executions.run_id`で行い、tagは使わない。Runが終端になったとき（RunCompletionServiceのterminal handler `AutomationChainHandler`。保留自動実行の後）、そのRunを作ったexecutionを引く。Jobの手動retryで作られたRunは`jobs.retry_of_job_id`を元のJobまで辿って元のRunのexecutionを使う。executionが無いRun（人が作ったRun。`automation.ruleId` tagが付いていても）は連鎖しない。上流ruleが無効なら下流を起動しない。
- 起動対象は`upstreamRuleId`がそのruleで、有効かつ版の系列を`modelFamilies`に含むrule。上流Runがfinishedで出力DatasetVersionがあれば、下流Runを同じ版で作る: `inputDatasetVersionIds`＝ruleの固定分＋上流Runの`outputDatasetVersionIds`、`upstreamDatasetVersionIds`＝上流Runの出力、`parentRunId`＝上流Run、`tags['automation.pipelineRoot']`＝1段目のexecution ID。上流がfinishedで出力が無ければ`skipped`・error`upstream_outputs_missing: …`、failed/canceledなら`skipped`・error`upstream_unsuccessful: …`。（下流rule, 上流Run）の組は1回だけ処理するので、complete再送でも重複しない。作成者権限・重み・参照先はモデル登録時と同じく再検証する。
- ModelAutomationExecutionは`triggerRunId`（下流を起動した上流Run。1段目はnull）、`pipelineRootExecutionId`（1段目のexecution。1段目は自身のid）、`attempt`（1始まり）、`source`（`automatic`|`manual`）、`requestedBy`（手動適用した利用者。自動はnull）を持つ。保留中の行は`triggerRunId:null`、`pipelineRootExecutionId`＝`id`、`attempt:1`、`source:'automatic'`。
- 手動適用`POST /projects/:p/automation-rules/:id/executions`はProject admin（global adminを含む）と`admin` scopeのtokenだけ（editorは403）。`model_registered`のruleは`{modelVersionId}`、`upstream_run_finished`のruleは`{triggerRunId}`を受け、逆は422 `automation_trigger_mismatch`。`triggerRunId`はfinished（違えば422 `upstream_run_not_finished`）で、そのruleの上流ruleが作ったRun（違えば422 `upstream_rule_mismatch`）で、出力DatasetVersionがあるRun（無ければ422 `upstream_outputs_missing`）に限る。ruleが無効なら422 `automation_rule_disabled`、版の系列がruleの`modelFamilies`に無ければ422 `incompatible_model_family`、同じruleと版のexecutionのJobがqueued/claimed/runningなら409 `automation_execution_active`。`attempt`は同じruleと版の最大＋1、`source:'manual'`、`requestedBy`を記録する。重み・作成者権限・参照先の再検証の結果は`skipped`/`failed`のexecutionとして201で返す。手動適用したRunが成功すると下流ruleは通常どおり連鎖する。監査は`automation.execution.manual`（403/409は`denied`）。
- 作成者権限の再確認は`effective_project_roles`（直接付与とgroup bindingの最大値）のadminまたはglobal adminで判定する。

## 評価結果の比較

Runは`upstreamDatasetVersionIds:string[]`を持つ。`inputDatasetVersionIds`の部分集合で、上流Run（推論など）の出力にあたる入力を示す。Run作成時に決まり変更できない（DBのCHECKとtriggerで拒否）。native/MLflowのRun作成APIからは指定できず、自動実行の連鎖が設定する。手動のRunは空。正解セット＝`inputDatasetVersionIds`−`upstreamDatasetVersionIds`（集合）。Runを返すすべての応答にこのfieldが付く。

- `GET /projects/:p/models/:id/versions/:v/evaluation-comparison?baselineAlias=&baselineVersionId=&referenceDatasetVersionIds=&codeVersionId=&evaluationRuleId=&metrics=` → EvaluationComparison。`:v`は候補のModelVersion ID。viewerと`read` scope。
- 基準は`baselineAlias`か`baselineVersionId`（同じModelの版）のどちらか一方。両方は422 `invalid_request`。どちらも省略すると`production` alias。
- `referenceDatasetVersionIds`と`metrics`はカンマ区切りまたは繰り返し。空の`referenceDatasetVersionIds=`は「正解セットなし」を指定する。省略した条件（正解セット、`codeVersionId`）は、候補版の最新の評価Runから取る。
- 比べる評価Runは、同じProject・`kind=evaluation`・`status=finished`・削除されていない・正解セットが集合として一致・`codeVersionId`が一致（nullどうしも一致）のRun。`evaluationRuleId`を指定すると、そのruleの自動実行（model_automation_executions.run_id）が作ったRunに限る。複数あれば`endedAt`、idの降順で最初のRun。
- 応答`{status,modelId,candidateVersionId,baselineAlias,baselineVersionId,candidateRunId,baselineRunId,referenceDatasetVersionIds,codeVersionId,evaluationRuleId,metrics:MetricComparison[]}`。statusは`ok`/`baseline_missing`（aliasが未設定）/`candidate_not_evaluated`/`baseline_not_evaluated`で、比較できなくてもエラーにしない。
- MetricComparison `{key,candidate,baseline,candidateStatus,baselineStatus,delta,relativeDelta,source:{candidate,baseline}}`。値は`present`/`missing`/`not_finite`（NaN・無限大。値はnull）。delta=候補−基準、relativeDelta=delta÷|基準|（基準0はnull）。sourceは`dataset_context`（MLflowの点で`mlflow_dataset_digest`が正解セットのDatasetVersion digestと一致する最新の点。step→timestampの順）か`run_latest`（`latestMetrics`へのfallback）。`metrics`を省略すると両側のmetric名の和集合を名前順に返す。
- 他ProjectのModel・ModelVersion・DatasetVersion・CodeVersion・ruleの指定は404。内部の判定（昇格policy）は認可を除いた`compareToBaselineInternal(connection, projectId, request)`を同じtransaction内で呼ぶ。詳細は[評価と基準版との比較](evaluation.md)。

## Runの説明文とコメント

- `PUT /projects/:p/runs/:r/note` ({content}) → RunNote `{runId,content}`。editor＋`runs:write`。説明文（Markdown）は`runs.tags['mlflow.note.content']`（contractsの`RUN_NOTE_TAG`）に保存し、Runの型は変えない。nativeのGET RunのtagsとMLflowのget-runの`mlflow.note.content`は同じ値で、MLflowのset-tagで書いた値もそのまま読める。上限はMLflowのtag値と同じ8000文字（`RUN_NOTE_MAX_LENGTH`、UTF-16単位）で、超えると422。空文字はtagを消す。nativeのPATCH tags（4000文字）を通さず、Runを行lockして説明文のkeyだけを書くので、ほかのtagは残る。削除済みのRunは409 `run_deleted`、別ProjectのRunは404。説明文は実験結果ではないので、Job付きRunの終端後もこのAPIでは編集できる（MLflowのset-tagは終端後の書き込み規則に従う）。Job限定tokenは403 `job_token_forbidden`。監査`run.note.update`（resource_type `run`、detailsは文字数`length`だけで本文を入れない）。
- Comment `{id,projectId,targetType:'run'|'model_version'|'report',targetId,parentCommentId,body:string|null,author:{id,displayName},createdAt,editedAt,deleted}`。返信は1段だけで、返信への返信は元のスレッドの先頭への返信として保存する（`parentCommentId`は常にスレッドの先頭）。本文は空白だけを除く1〜20000文字（`COMMENT_MAX_LENGTH`）。削除は論理削除で、削除済みは`body=null`・`deleted=true`のままスレッドの位置に残る。
- `GET /projects/:p/comments?targetType=&targetId=&cursor=&limit=` → `{items:Comment[],nextCursor:string|null}`。viewer＋`read`。スレッド順（先頭のcreatedAt・id、各スレッドの返信はその直後にcreatedAt・id順）。limitは既定100、最大200。cursorは前ページ末尾のComment IDで、同じ対象のものでなければ404。対象が同じProjectに無ければ404（削除済みの対象のコメントは読める）。
- `POST /projects/:p/comments` ({targetType,targetId,parentCommentId?,body}) → Comment（201）。editor。tokenのscopeは対象に応じて`run`/`report`=`runs:write`、`model_version`=`registry:write`。対象が別Project・存在しなければ404、削除済みのRun（`lifecycle_stage='deleted'`）・モデル版（MLflowで版またはModelを削除）なら409 `comment_target_deleted`。返信先が別の対象のコメントなら422 `comment_parent_mismatch`。未登録の対象種別（`report`はreports-apiが登録するまで）は422 `comment_target_unsupported`。
- `PATCH /projects/:p/comments/:c` ({body}) → Comment。作成者（editor以上）だけで、他人は403 `comment_author_required`、削除済みは409 `comment_deleted`。`editedAt`を更新する。`DELETE /projects/:p/comments/:c` → 204。作成者（editor以上）かProject adminだけで、ほかは403 `comment_delete_forbidden`。削除済みへの再削除も204で、監査は増えない。編集・削除もtokenには対象種別のscopeを要求する。Job限定tokenは投稿・編集・削除とも403 `job_token_forbidden`。
- 監査`comment.create`・`comment.update`・`comment.delete`（resource_type `comment`、resource_idはComment ID、detailsに`targetType`・`targetId`。createは`parentCommentId`、deleteは`byAuthor`も）。本文は入れない。

## 監査ログ

認証・Project・token・権限などの操作を`audit_events`へ記録する。AuditEventは`{id,occurredAt,actorType:'user'|'token'|'system',actorUserId,actorTokenId,action,outcome:'success'|'denied'|'failed',resourceType,resourceId,projectId,details,ip,userAgent}`。成功の記録は業務と同じtransactionでINSERTし、業務がrollbackすれば記録も残らない。拒否・失敗の記録は業務のtransactionの外で書く。`details`へpassword・token・secretの値を入れない。`ip`はAPIが受けたsocketの接続元で、転送ヘッダーは信頼しない。

- `GET /audit-events?projectId=&action=&actorUserId=&outcome=&limit=&cursor=` → AuditEventPage `{items:AuditEvent[],nextCursor:string|null}`。全体管理者のsessionだけ。API tokenはProject制限の有無にかかわらず403 `session_required`。Projectに属さない記録（`projectId=null`。認証など）もここで読める。
- `GET /projects/:p/audit-events?action=&actorUserId=&outcome=&limit=&cursor=` → 同じ形。Project admin（API tokenは`admin` scopeとProject制限・membershipも要求）。
- 新しい順（occurredAt、idの降順）。limitは既定50、最大200。cursorは前ページ末尾のAuditEvent ID。存在しないcursor、または別Project・絞り込みの対象外のcursorは404。
- 拒否の記録は権限不足（403）と競合（409）だけで、`outcome='denied'`と`details.code`（APIのerror code）を持つ。入力検証エラーや存在しない対象は記録しない。
- action: `auth.login`（details.method=`local`/`oidc`/`development`。失敗は`outcome='failed'`、actorは`system`）、`auth.logout`、`auth.password.change`、`auth.bootstrap_admin`（端末の`bootstrap-admin`で初期管理者を作成・再設定）、`auth.oidc.sync`（SSOのUserを作成・連携した、または全体role・groupが変わった。details: created、linkedExisting、globalRoleBefore/After、groupsAdded/Removed）、`auth.oidc.denied`（SSOのloginを断った。`outcome='denied'`、actorは`system`、details: reason、subject、email）、`project.member.set`（旧role/新role）、`token.create`（name、kind、scopes、expiresAt）、`token.revoke`。回数制限で429にした試行は記録しない。
- 記録は無期限に保存する。削除・変更のAPIはなく、DBでもUPDATE/DELETEを拒否する。

## Worker API

- `POST /worker/claim` ({workerId,targetIds?:string[],activeJobIds?:string[],workerInfo?}) → `{item:WorkerJob|null}`。DB transaction＋SKIP LOCKED、target/GPU予約、worker project scope、ランダムleaseを使う。targetが対応しないruntimeは候補から除外し、返す前にも版/runtime/Artifact/GPUを再検証する。検証失敗でleaseやGPU予約は残らない。activeJobIdsは既に監視中のJobを指定する。そのID以外に同じworkerの未完了Jobがあれば同じleaseで回収し、なければ次をclaimする。同じpayloadの再送で新たなJobを重複claimしない。
- `POST /worker/resume` ({workerId,targetIds?:string[],workerInfo?}) → `{items:WorkerJob[]}`。同じworkerIdとproject scopeのclaimed/running jobを同じleaseのまま返す。別workerへ自動再claimしない。
- `POST /worker/jobs/:id/heartbeat` ({leaseId,status?:'running'}) → `{cancelRequested:boolean}`。
- `POST /worker/jobs/:id/metrics` ({leaseId,metrics:MetricPoint[]})、`POST .../logs` ({leaseId,entries:LogEntry[]})。
- `POST /worker/jobs/:id/complete` ({leaseId,status:'finished'|'failed'|'canceled',exitCode?,error?})。同じleaseの再送は安全。古いleaseからの状態変更を拒否。
- WorkerはAPI heartbeatと並行してSSH commandを実行する。切断してもremote processを二重起動しないためjob別workspaceのPID/statusファイルでattach・回収する。worker停止後のleaseは安易に再実行せず、同じworkerの復帰で再attachするか状態不明として扱う。再実行は明示操作。
- 在籍登録: claim/resume の任意の`workerInfo`は`{version?:string,hostname?:string,parallelJobs?:int(1..1000)}`。表示用の自己申告で、認可には使わない。claim/resume/heartbeat の受付で`workers`（主キーは token ID と workerId）の`lastSeenAt`を更新する。claimは毎秒来るので、前回の記録から15秒（`WORKER_PRESENCE_WRITE_INTERVAL_SECONDS`）未満で内容（版、ホスト名、targetIds、parallelJobs）も変わらなければ書き込まない。workerInfoで省略した項目は前回の値を残す。120秒以上応答のなかった worker が戻ると`startedAt`を今に戻す。
- `GET /projects/:p/workers` → `{items:WorkerPresence[]}`。viewer、API tokenは`read` scope。`GET /workers` → 全Projectの同じ形。全体管理者だけ。WorkerPresenceは`{projectId,tokenId,tokenName,workerId,version,hostname,targetIds:string[]|null,parallelJobs,startedAt,lastSeenAt,status:'online'|'offline',activeJobCount}`。`targetIds=null`は全targetを対象にする worker。`status`はDBの時刻で`lastSeenAt`から120秒（`WORKER_OFFLINE_SECONDS`）を超えると`offline`。`activeJobCount`はその worker の claimed/running Job数。最終応答の新しい順に最大1000件。
- Job の`heartbeatStale:boolean`は派生値で、claimed/running かつ`heartbeatAt`から60秒（`JOB_HEARTBEAT_STALE_SECONDS`、heartbeat 5秒の12回分）を超えると true。表示だけに使い、Jobの状態変更、GPU予約の解放、別workerへの再claim、自動再実行はしない。
- GPUなしのCPU実行はgpuIds=[]。実際のGPU計測はnvidia-smiで任意に採取。WorkerはAPI/ログへ鍵・token・シークレット値を出さない。
- 環境: `MMT_API_URL`, `MMT_API_TOKEN`, `MMT_WORKER_ID`, `MMT_WORKER_TARGET_IDS`。SDKはstart_run、log_params/tags/metrics、log_artifact、register_model/dataset等を提供。例と実行する小さいtraining/inference scriptを同梱する。

### Job限定token

- `WorkerJob.jobToken:string|null`。claim/resumeで返すJobが`claimed`（まだ実行コードを起動していない）なら、そのJobの既存Job tokenを失効させて新しく発行し、値を一度だけ返す。claim応答が失われて同じJobが再度返る場合も再発行され、旧tokenは401になる。`running`のJobでは`null`（実行中のprocessは既にtokenを持ち、workerはjournalに保存した値を使う）。workerは実行開始の直後に`status:'running'`のheartbeatを送り、再起動時の再発行で実行中processのtokenを失効させないようにする。準備中のJobがclaim失敗後のresumeで再発行を受けた場合、workerは実行コードの起動直前に新しいtokenへ切り替える。
- 接頭辞`mmtj_`＋32 byteの乱数。DBにはSHA-256 hashだけを保存する（`job_tokens`）。principalはRunの作成者（`users.status='active'`）、`method='token'`、scopeは`read`,`runs:write`,`artifacts:write`,`registry:write`。Project権限はRun作成者の現在のmembershipで判定する（外されると403）。
- 有効なのは、失効しておらず、Jobが発行時と同じleaseのまま`claimed`/`running`の間だけ。終端（finished/failed/canceled）やleaseの変更で401。
- 読み出しはtokenのProject配下（`GET|HEAD /projects/:p/*`、`/mlflow/projects/:p/*`）と、読むだけのsearch（`POST /projects/:p/runs/search`、MLflowの`runs/search`・`experiments/search`・`logged-models/search`・`registered-models/get-latest-versions`）。
- 書き込みは次の許可表に一致したものだけ。それ以外（`/worker/*`、Run作成、他Runへの書き込み、token発行、Project設定、自動実行rule、Runの説明文、コメント等）は403 `job_token_forbidden`（MLflowは`PERMISSION_DENIED`）。許可表に無いrouteは追加されても既定で拒否される。
  - native: `PATCH /projects/:p/runs/:r`、`POST .../runs/:r/metrics`、`POST .../runs/:r/logs`、`PUT .../runs/:r/artifacts`（`:r`がtokenのRun）。`POST /projects/:p/artifact-uploads`（`body.runId`がtokenのRun）と、そのsessionの`PUT .../parts/:n`・`POST .../complete`・`DELETE /artifact-uploads/:u`（sessionの`run_id`がtokenのRun）。`POST /projects/:p/models`。`POST .../models/:m/versions`と`POST .../datasets/:d/versions`（`body.sourceRunId`がtokenのRun）。
  - MLflow: `runs/update`・`log-parameter`・`log-metric`・`log-batch`・`set-tag`・`delete-tag`・`log-inputs`・`outputs`・`log-model`（`run_id`/`run_uuid`がtokenのRun）。`registered-models/create`。`model-versions/create`（`run_id`を指定するならtokenのRunで、`source`がtokenのRunのArtifactか、tokenのRunをsourceとするLogged Model）。`POST logged-models`（`source_run_id`がtokenのRun）と、そのLogged Modelの`PATCH`・`PATCH .../tags`・`DELETE .../tags/:key`・`POST .../params`。`PUT mlflow-artifacts/artifacts/runs/<tokenのRun>/…`と`…/models/<tokenのRunのLogged Model>/…`。
- workerは実行コードの`MMT_API_TOKEN`と`MLFLOW_TRACKING_TOKEN`にJob tokenを渡し、worker tokenは渡さない。Job tokenが無ければ実行コードを起動しない。workerが自分で行うheartbeat・metrics/logs転送・出力upload・completeは従来どおりworker token。

## 再開可能なArtifact upload

単一PUTは失敗すると全量を送り直すので、大きなArtifactはupload sessionで分割して送る。API経由の独自sessionで、S3ではmultipart upload、filesystemでは`<ARTIFACT_FILESYSTEM_ROOT>/.uploads/<uploadId>/<n>.part`にpartを置く。presigned URLでの直接転送は今回作らない。

- 権限はeditor＋`artifacts:write`。sessionを使える（一覧・取得・part・complete・abort）のは作成したUserが同じ認証情報（session、同じAPI token、または同じJob限定token）で呼ぶときだけで、それ以外は403 `upload_forbidden`。
- `POST /projects/:p/artifact-uploads` ({path,runId?,mimeType?,expectedSize,expectedSha256?,partSize?}) → 201 ArtifactUpload。保存先はProjectの`artifactBackend`。`partSize`は既定16MiB、5MiB〜5GiB（範囲外は422 `invalid_part_size`）。part数`ceil(expectedSize/partSize)`は10000以下（超えると422 `too_many_parts`）。`expectedSize`が`MMT_ARTIFACT_MAX_BYTES`を超えると413 `artifact_too_large`。削除済みRunは409 `run_deleted`。期限（`expiresAt`）は作成から7日。
- `GET /projects/:p/artifact-uploads?status=` → `{items:ArtifactUpload[]}`。自分のsessionだけを返す。
- `GET /projects/:p/artifact-uploads/:u` → ArtifactUploadDetail（`receivedParts:{partNumber,size,sha256,receivedAt}[]`）。再開時は欠けたpartだけを送る。
- `PUT /projects/:p/artifact-uploads/:u/parts/:n` (raw body) → ArtifactUploadPart。part番号は1〜`partCount`。最後以外のpartは`partSize`、最後は残りのbyte数ちょうどで、`Content-Length`が一致しなければ422 `part_size_mismatch`。任意の`X-Part-SHA256`（hex）が一致しなければ422 `part_checksum_mismatch`。どちらもpartを受け取り済みにしない。同じ番号の再送は上書きする。`open`以外は409 `upload_not_open`、期限切れは409 `upload_expired`。
- `POST /projects/:p/artifact-uploads/:u/complete` → 202 ArtifactUpload（`status:'verifying'`）。全partが揃っていなければ409 `upload_incomplete`、削除済みRunは409 `run_deleted`。`verifying`・`completed`のsessionへの再送は現在の状態を202で返す。
- Job限定tokenは自分のRun（`runId`）のsessionだけを作れる。Job tokenで作ったsessionは、Runの作成者本人のbrowser sessionやAPI tokenからも使えない（leaseが終わると続きを送れない）。
- `DELETE /projects/:p/artifact-uploads/:u` → ArtifactUpload（`status:'aborted'`）。受け取ったpartを捨てる。`open`以外（abort済み・期限切れを除く）は409 `upload_not_open`。
- `status`は`open`→`verifying`→`completed`、または`aborted`/`expired`/`failed`。API内のfinalizerがpartを連結し、組み立てたobjectを1回streamingで読んで全体のsize・SHA-256を計算する。`expectedSha256`と違えば`failed`（`error:'sha256_mismatch'`）で、Artifactもblobも残さない。検証中にRunが削除されたら`failed`（`run_deleted`）。成功すると`completed`で、登録したArtifactのidはupload idと同じ（`artifactId`）。completeを何度送ってもArtifactは1件。finalizerはleaseを持ち、APIが途中で止まってもleaseの失効後に別のprocessが続きから完了させる。
- 期限切れの`open` sessionは定期処理で`expired`にし、保存先のmultipart uploadをabortする。sessionの無い7日以上前の未完了multipart uploadと、24時間更新の無いfilesystemの書きかけstagingも消す。

## Platform保存API（親担当）

`@mmt/platform`は`createArtifactStoresFromEnv(env?)` → `ArtifactStores`をexportする。`stores.backends():ArtifactBackend[]`、`stores.put({backend,key,body:Readable,mimeType})` → `{size,sha256}`、`stores.read({backend,key,range?:string})` → `{body:Readable,size,totalSize,contentRange?:string,status:200|206}`。`stores.remove({backend,key})`。`stores.multipart(backend)`は再開可能uploadに対応する保存先で`createMultipart`／`putPart`（宣言sizeと任意のpart SHA-256を検証）／`completeMultipart`（S3は最後以外5MiB以上）／`abortMultipart`／`listIncompleteUploads`／`removeAbandonedStaging`を返し、未対応ならnull。S3の単一`put()`は送信元の失敗時にAbortMultipartUploadの完了を待ってからrejectする。keyはprojectId/artifactId配下の不変ID。登録DB失敗時は書いたblobをcleanup。streamingでGBファイルを全量メモリへ載せない。`.env`設定は`ARTIFACT_FILESYSTEM_ROOT`、`S3_BUCKET`, `S3_ENDPOINT?`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`。FSは常時available、S3は必要設定がある場合available。

`createPluginClient({baseUrl,token})` → `manifest()`, `searchDatasets(query)`, `metrics()` → `{prometheus:string}`, `sendEvent(event)`。HTTP POST `/datasets/search`、`/events`、GET `/manifest`。deadlineとvalidation必須。専用pluginはprivate networkで管理者が設定する。任意ユーザーがURLを指定できない。

## ローカル検証

親担当は独立PostgreSQL containerとポート55483、API4182、Web5182を使う。既存Mado DB等を変更しない。テストDB URLは親が`artifacts/coordination/2026-10-08/environment.json`に認証情報を含めず案内する。migrationは担当が作成しrootが適用する。Web表示は実APIのseedデータを使い、API失敗をダミーデータで隠さない。
