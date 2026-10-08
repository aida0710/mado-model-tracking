# 運用と接続設定

## 認証方式（AUTH_MODE）

`AUTH_MODE`でログイン方法を選びます。既定は`hybrid`です。

| AUTH_MODE | 使えるログイン | 必須の設定 | 向いている場面 |
|---|---|---|---|
| `local` | ローカルアカウント | なし（`OIDC_*`は読まない） | SSOが無い環境、閉じたLAN |
| `oidc` | Authentik（SSO）だけ | `OIDC_ISSUER_URL`、`OIDC_CLIENT_ID` | SSOへ移行し終えた本番 |
| `hybrid` | SSOとローカルアカウント | `OIDC_ISSUER_URL`、`OIDC_CLIENT_ID` | SSOの導入中。Local Adminを緊急経路に残す |
| `development` | 開発用ログイン | なし | ローカル開発。`NODE_ENV=production`では起動しない |

必須の設定が欠けると、APIは設定名だけを示して起動しません。無効なmodeの経路は404を返します（`local`のOIDC開始・callback、`oidc`の`POST /api/auth/local-login`）。

Web sessionはidle期限`AUTH_SESSION_IDLE_SECONDS`（既定28800=8時間）とabsolute期限`AUTH_SESSION_ABSOLUTE_SECONDS`（既定43200=12時間）の早い方で切れます。idleがabsoluteを超える設定は起動時に拒否します。SSOボタンの表示名は`OIDC_LABEL`（既定`Authentik`）です。

ローカルアカウントのパスワードはArgon2id（memory 19456KiB、time 2、parallelism 1）で保存し、12〜1024 byteを受け付けます。ログインは接続元ごとに1分30回、同じユーザー名への失敗は15分10回、パスワード変更時の現在のパスワード確認はユーザーごとに15分10回までで、超えると429と`Retry-After`を返します。回数はAPIプロセスのメモリにあり、再起動で戻ります。Argon2の同時計算は4件までです。存在しないユーザー名、誤ったパスワード、無効化したユーザーは同じ401を返します。ログイン・ログアウト・パスワード変更・初期管理者の作成は監査ログ（`audit_events`の`auth.login`、`auth.logout`、`auth.password.change`、`auth.bootstrap_admin`）に残り、パスワードやOIDCのcode・stateは記録しません。回数制限で429になった試行は記録しません。

### 初期管理者（bootstrap-admin）

API serverの端末で対話的に実行します。ユーザー名とパスワードは端末から入力し、コマンド引数やログには出しません。

```sh
npm run bootstrap-admin -w @mmt/api
```

同じユーザー名が既にあれば、全体管理者・有効に戻してパスワードを置き換え、そのユーザーのsessionを失効させます。作成・再設定したアカウントは次のログインでパスワードの変更が必要で、変更するまで`GET /api/auth/config`・`GET /api/auth/me`・`POST /api/auth/change-password`・`POST /api/auth/logout`以外は403 `password_change_required`になります。パスワードを変更すると、同じユーザーのほかのsessionは失効します。ローカルアカウントの利用者は、上部バーのユーザー表示から`/account/password`を開いていつでも変更できます。

### SSOへの移行手順

1. `AUTH_MODE=hybrid`とAuthentikの設定（下記）を入れて`npm run db:migrate`の後にAPIを再起動し、`bootstrap-admin`でLocal Adminを作ってパスワードを変更します。
2. 管理者と一般メンバーがSSOでログインし、全体管理者の判定とProject権限が正しいことを確認します。migration 010で既存のSSOユーザーは`user_oidc_identities`へ移り、同じユーザーIDのままログインできます。
3. 確認できたら`AUTH_MODE=oidc`へ変えて再起動します。Local Adminのログインは404になります。SSOが止まったときは`hybrid`へ戻すとLocal Adminでログインできます。

migration 010はsessionに`auth_method`を必須で追加します。migration後は新しいAPIへ入れ替えてください（古いAPIはsessionを作れません）。

## 監査ログ

認証（上記）、Projectメンバーの権限変更（`project.member.set`）、API tokenの発行・失効（`token.create`、`token.revoke`）を`audit_events`に記録します。業務の変更と同じtransactionで書くので、変更が戻れば記録も残りません。権限不足（403）と競合（409）で拒否した操作は、transactionの外で`outcome=denied`と`details.code`付きで残します。入力の検証エラーや存在しない対象は記録しません。token原文・hash・パスワードは記録せず、接続元IPとUser-Agentを残します。監査ログは無期限に保存し、削除機能はありません。

Project adminは設定画面の「監査ログ」で自分のProjectの記録を新しい順に読めます。Projectに属さない記録（ログインなど）を含む全体の一覧は`GET /api/audit-events`で、全体管理者のsessionだけが読めます（API tokenでは読めません）。

## Authentik

AuthentikにOAuth2/OpenID ProviderとApplicationを用意します。client secretはAPI serverにだけ設定します。Redirect URIには`https://<アプリのホスト>/api/auth/callback`を完全一致で登録し、per-providerのissuerを使います。Providerの設定方法は[Authentik公式資料](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)を参照してください。

API server側の設定:

```dotenv
NODE_ENV=production
AUTH_MODE=hybrid
MMT_PUBLIC_URL=https://tracking.example.com
MMT_WEB_ORIGIN=https://tracking.example.com
OIDC_ISSUER_URL=https://sso.example.com/application/o/model-tracking/
OIDC_CLIENT_ID=<providerのclient ID>
OIDC_CLIENT_SECRET=<secret>
OIDC_ADMIN_GROUP=mmt-admins
OIDC_LABEL=Authentik
```

アプリはAuthorization Code＋PKCE、state、nonce、ID tokenの署名・issuer・audienceを検証します。`openid profile email`を要求し、`email_verified=true`が必要です。Authentik側のscope mappingから必要なclaimをID tokenへ出してください。`groups`配列に`mmt-admins`がある利用者だけが全体管理者になります。Project内の権限はアプリで個別に設定します。

Web sessionはHttpOnly/SameSite=Lax cookieで、期限は上の`AUTH_SESSION_*`に従います。変更操作はOriginを検証します。アプリからのlogoutはアプリsessionを失効させます。Authentik全体のsession logout、SCIM、back-channel logoutは提供しません。

LAN/VPNから使う場合は`MMT_ALLOW_PRIVATE_ORIGINS=true`を設定します。CORS、ログイン/logout、sessionの変更操作で同じ判定を使い、HTTP(S)のIPv4 private・loopback・link-local・CGNAT、IPv6 ULA・loopback・link-localとlocalhostを許可します。設定省略時はfalseです。DNS名で使う場合は`MMT_WEB_ORIGIN`と`MMT_PUBLIC_URL`へ実際のURLを設定してください。Originが欠落/nullの場合や、許可されていないpublic IP・DNS名は拒否します。Bearer API tokenは従来どおりOriginなしで使えます。

開発Webはport5182でLANから接続できます。`/api`はloopbackのAPI4182へproxyします。Authentikのcallbackは`MMT_PUBLIC_URL`の固定URLを使うので、SSOで使うURLはProviderにも完全一致で登録します。

初回に管理者がloginしProjectを作成します。メンバーは一度SSOでloginするとユーザーIDが作られ、Projectの設定からそのIDでviewer/editor/adminを付けられます。API tokenは発行時のscopeに加え、その所有者の現在のProject membershipを確認します。

## Artifacts

ファイルシステムは`ARTIFACT_FILESYSTEM_ROOT`配下に、API serverだけが読める権限で保存します。サーバー生成IDを保存キーにし、利用者のファイル名は表示用metadataとして扱います。API server間で共有する場合は同じ永続volumeが必要です。

S3は`S3_BUCKET`を設定するとProjectの保存先に選べます。`S3_ENDPOINT`未指定ならAWS S3です。互換サービスでは`S3_ENDPOINT`と必要に応じて`S3_FORCE_PATH_STYLE=true`を設定します。AWS SDKの標準credential provider、または対になった`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`を使います。必要権限は対象prefix内のPut/Get/Delete、multipart uploadとabortです。

S3では、upload中に送信元が失敗するとmultipart uploadを中断しますが、中断の完了を待たずに失敗を返します。その間にAPIが止まるとpartが残るため、実bucketにはAbortIncompleteMultipartUploadのlifecycle ruleを設定してください。実bucketでの保存・取得の確認手順は[検証手順](verification.md)の「実S3の保存・取得を確認する」にあります。

保存先の変更は以後のuploadに効きます。既存Artifactは保存したbackendを記録しているので、元のストレージも読み取り可能な状態にします。uploadはstreamingでSHA-256を計算し、DB登録に失敗したblobを削除します。mediaのseekはHTTP Rangeを使います。HTML/SVG等はダウンロード扱いにします。

DBとArtifactsは同時点でバックアップします。DBだけのrestoreでは重み・画像・音声を戻せません。

### uploadの上限とtimeout

- 1件の上限は`MMT_ARTIFACT_MAX_BYTES`（既定200GiB = 214748364800）です。超えるとnativeは413 `artifact_too_large`、MLflow経路は413 `RESOURCE_EXHAUSTED`を返します。Content-Length付きなら保存を始める前に、chunk転送なら超えた時点で中断し、書きかけのblobを消します。
- `MMT_UPLOAD_REQUEST_TIMEOUT_MS`（既定0 = 無効）はrequest全体の締め切りです。0以外にすると、その時間を超えるuploadは408で切れます。Nodeの既定は300000（5分）で、以前はこれが効いて5分を超える単一PUTが切れていました（2026-10-08に実測）。
- `MMT_UPLOAD_IDLE_TIMEOUT_MS`（既定120000）は、socketが無通信のまま続いたら切る時間です。download中にブラウザが読み込みを止めた場合も切れますが、ブラウザはRange付きで取り直します。
- headerの受信は常に60秒以内です（slowloris対策）。
- 前段proxyには、request全体のtimeoutを設けず、無通信のtimeoutをAPIと同じ120秒程度にし、bodyをbufferせずstreamでAPIへ渡す設定が必要です。同梱の`deploy/nginx.conf`は`client_max_body_size 0`、`proxy_request_buffering off`、`client_body_timeout 120s`、`proxy_send_timeout 120s`、`proxy_read_timeout 3600s`です。
- 開発用Web（Vite、port5182）もMLflowの`MLFLOW_TRACKING_URI`としてuploadの経路になるため、Viteのdev/preview serverのrequestTimeoutを0にしています。検証で別のAPIを指すときは`MMT_WEB_API_PROXY_TARGET`でproxy先を変えられます（既定`http://127.0.0.1:4182`）。

### 配信

- `GET /projects/:p/artifacts/:a/content`は`ETag: "sha256-<hex>"`と`Cache-Control: private, max-age=31536000, immutable`を返します。`If-None-Match`が一致すれば304、`If-Range`が一致しなければRangeを無視して200です。MLflow経路のdownloadはpathの付け替えがあるため`no-store`のままです（ETagは同じ形式）。
- upload時のContent-Typeが空か`application/octet-stream`なら、拡張子からMIMEを推定します（wav、flac、mp3、ogg、opus、m4a、aac、webm、mp4、mov、png、jpg、webp、avif、gif、csv、tsv、jsonl、txt、npy、parquet）。HTML・SVG・XML・JSは推定しません。既存のArtifactのMIMEは書き換えません。

## SSH/GPU worker

workerはAPI serverとは別processです。SSH秘密鍵とknown_hostsはworkerのfilesystemに置き、ComputeTargetにはパスだけ登録します。known_hostsの確認を無効にしません。接続先のPythonとvenv/pip、コードが必要とするCUDA/driverは実行先に用意してください。鍵・tokenをCodeVersion.environmentへ書かないでください。

workerにはProject限定のService Account tokenを渡します。`read`、`worker:execute`、コードsnapshotを保存する`artifacts:write`を付けます。実行中コードのSDKが記録する場合は`runs:write`、モデルやデータセットを登録する場合は`registry:write`も必要です。詳細は[worker手順](worker.md)を参照してください。

GPU予約はこのアプリ内のJob間で排他にします。ほかのSSH shellや別schedulerが同じGPUを使うことまでは防げません。共有GPUではアプリ専用のGPU一覧・作業directoryを設定してください。

worker identityとstate directoryは再起動後も保持します。APIやSSHの応答が失われても、実行状態を確認するまで同じJobを二重起動しません。状態未確認のJobのGPUを自動解放しません。停止要求後はworkerから終了が報告されてから再実行します。

## Run終端の後処理が失敗したとき

Runが終端（finished/failed/canceled）になったときの後処理（出力モデルの登録、保留中の自動実行など。handlerは今後追加します）は、handlerごとにSAVEPOINTを張って実行します。handlerが例外を出すと、そのhandlerの変更だけを戻し、Run/Jobの終端とGPU予約の解放は確定し、後続のhandlerも実行します。

失敗はAPIの標準エラー出力に1行のJSONで出ます。

```json
{"event":"run_completion_handler_failed","handler":"<handler名>","runId":"<Run ID>","message":"<例外のmessage>"}
```

この行が出たら、そのRunの後処理（登録記録・自動実行の記録など）が欠けていないかを確認してください。自動では再実行しません。失敗を記録として残す必要があるhandler（出力登録、昇格判定）は、各handlerが自分の表に残します。

MLflowのRunは終端から`RUNNING`へ戻して再び終端にできるため、同じRunでhandlerが2回以上呼ばれることがあります。handlerは二重に処理しないように作ります。

plugin outboxへのイベント投入はhandlerではありません。状態が変わるたび（run.startedを含む）と、終端Runへの出力・Dataset追加の再送で積まれ、失敗するとRunの変更ごと戻ります。終端への遷移はRunを`FOR UPDATE`でlockするので、同じRunへの出力モデル登録と直列になり、終端イベントの`run.outputModelVersionIds`には確定済みの版が入ります。

## Gitのファイルをエディタへ読み込む

API serverにも`git`、`ssh`、CA証明書が必要です。`Dockerfile.api`には同梱しています。公開HTTPSリポジトリは完全なcommit hashを指定します。Webで読み込むファイル数・サイズは制限し、省略したファイルを画面に表示します。Git設定やユーザーの認証情報を自動で引き継ぎません。

SSHリポジトリを読み込む場合は、API serverに`MMT_GIT_SSH_KEY_PATH`と`MMT_GIT_KNOWN_HOSTS_PATH`を両方設定します。値はサーバー内の絶対パスで、秘密鍵はmode600、known_hostsは事前に確認したものを使います。設定がなければSSHのファイル読込は拒否します。この設定はエディタの読込用です。JobのGit取得は実行先で行うため、private repositoryの認証はその実行先にも必要です。

## Docker Compose

`compose.yml`は本番構成の雛形です。ここでは外部環境へdeployしません。`.env`に上記のOIDC/HTTPS設定と`MMT_POSTGRES_PASSWORD`を入れます。DB URLにも使うためpasswordはURLでそのまま使える十分長いhex文字列にしてください。

```bash
docker compose build
docker compose up -d postgres
docker compose run --rm api npm run db:migrate --workspace @mmt/api
docker compose up -d api web
```

Webはlocalhost:5182で待ち受けます。外側のTLS reverse proxyからこのportへ接続します。API/DBは外部portを公開しません。Artifact volumeはAPIの実行ユーザーに書き込み権限を持たせます。workerとpluginは別に起動します。

## 外部接続を確認するとき

1. Authentikで管理者と一般メンバーがloginし、管理者group・Project権限が正しく反映されることを確認します。
2. SSH targetで小さいinference Jobを実行し、指定GPU・ログ・メトリクス・停止・再実行を確認します。
3. 実際のS3 bucketで小さいuploadとRange取得を行い、prefix権限・永続化・multipart cleanupを確認します。
4. Mado pluginからNamespaceを限定したDatasetVersionを取り込み、入力と出力のlineageを送信します。
