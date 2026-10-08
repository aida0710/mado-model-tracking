# 運用と接続設定

## 認証方式（AUTH_MODE）

`AUTH_MODE`でログイン方法を選びます。既定は`hybrid`です。

| AUTH_MODE | 使えるログイン | 必須の設定 | 向いている場面 |
|---|---|---|---|
| `local` | ローカルアカウント | なし（`OIDC_*`は読まない） | SSOが無い環境、閉じたLAN |
| `oidc` | Authentik（SSO）だけ | `OIDC_ISSUER_URL`、`OIDC_CLIENT_ID`、`OIDC_ALLOWED_GROUPS` | SSOへ移行し終えた本番 |
| `hybrid` | SSOとローカルアカウント | `OIDC_ISSUER_URL`、`OIDC_CLIENT_ID`、`OIDC_ALLOWED_GROUPS` | SSOの導入中。Local Adminを緊急経路に残す |
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

認証（上記と、SSOの同期・拒否の`auth.oidc.sync`・`auth.oidc.denied`。下の「Authentik」）、Projectメンバーの権限変更（`project.member.set`、`project.member.delete`）、SSO groupへのProject権限の付与（`project.group_binding.set`、`project.group_binding.delete`）、API tokenの発行・失効（`token.create`、`token.revoke`）を`audit_events`に記録します。業務の変更と同じtransactionで書くので、変更が戻れば記録も残りません。権限不足（403）と競合（409）で拒否した操作は、transactionの外で`outcome=denied`と`details.code`付きで残します。入力の検証エラーや存在しない対象は記録しません。token原文・hash・パスワードは記録せず、接続元IPとUser-Agentを残します。監査ログは無期限に保存し、削除機能はありません。

Project adminは設定画面の「監査ログ」で自分のProjectの記録を新しい順に読めます。Projectに属さない記録（ログインなど）を含む全体の一覧は`GET /api/audit-events`で、全体管理者のsessionだけが読めます（API tokenでは読めません）。

## Authentik

アプリはOIDC Authorization Code Flow + PKCEを使います。MFA、password policy、recovery、login flowはAuthentikを正本とし、アプリはUser、全体role、browser session、監査ログを管理します。Project内の権限はアプリで設定します。

### Authentikに登録する値

`https://tracking.example.com`は実際のHTTPS URL（`MMT_PUBLIC_URL`）へ置き換えます。

| 項目 | 値 |
|---|---|
| Redirect URI | `https://tracking.example.com/api/auth/callback`（完全一致） |
| Issuer | application単位のURL（例: `https://sso.example.com/application/o/model-tracking/`） |
| Scope | `openid profile email`（`OIDC_SCOPES`と同じにする） |

AuthentikではApplicationとOAuth2/OpenID Providerを作ります。client secretはAPI serverにだけ設定します。ID tokenに`email`、`email_verified`、`name`、`groups`（group名の配列）を出すscope mappingが必要です。Providerの設定方法は[Authentik公式資料](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)を参照してください。

アプリはstate、nonce、PKCE、ID tokenの署名・issuer・audienceを検証します。OIDC開始時に短命のHttpOnly cookieを発行し、callbackは同じbrowserからだけ受け付けます。

### 設定例

導入時はLocal Adminを緊急経路として残すため`hybrid`を推奨します（上の「SSOへの移行手順」）。本番ではHTTPSが必須です。

```dotenv
NODE_ENV=production
AUTH_MODE=hybrid
MMT_PUBLIC_URL=https://tracking.example.com
MMT_WEB_ORIGIN=https://tracking.example.com
OIDC_ISSUER_URL=https://sso.example.com/application/o/model-tracking/
OIDC_CLIENT_ID=<providerのclient ID>
OIDC_CLIENT_SECRET=<secret>
OIDC_LABEL=Authentik
OIDC_SCOPES=openid profile email
OIDC_AUTO_LINK_VERIFIED_EMAIL=false
OIDC_ALLOWED_GROUPS=mmt-users,mmt-admins
OIDC_ROLE_MAPPING_JSON={"mmt-admins":"admin","mmt-users":"user"}
OIDC_DEFAULT_ROLE=user
```

| 設定 | 意味 |
|---|---|
| `OIDC_ALLOWED_GROUPS` | loginを許すgroup（カンマ区切り）。`oidc`/`hybrid`で必須で、空なら起動しません |
| `OIDC_ROLE_MAPPING_JSON` | group→全体roleの対応表。roleは`admin`（全体管理者）と`user`（loginのみ）。ほかの値は起動時エラー |
| `OIDC_DEFAULT_ROLE` | 対応表のどのgroupにも入っていない許可ユーザーの全体role。既定`user` |
| `OIDC_ADMIN_GROUP` | `{"<group>":"admin"}`の省略形（以前からの設定）。対応表と両方指定して、adminのgroupが食い違うと起動しません。どちらも無ければ`mmt-admins`をadminとします |
| `OIDC_AUTO_LINK_VERIFIED_EMAIL` | 同じemailのLocal Userへ自動連携するか。既定`false` |
| `OIDC_SCOPES` | 要求するscope。既定`openid profile email`。`openid`が無いと起動しません |

対応表に書いたgroupも`OIDC_ALLOWED_GROUPS`に入れてください。許可groupに無いgroupだけを持つ人は、対応表に関係なくloginできません。

以前の版から更新するときは、`OIDC_ALLOWED_GROUPS`を足してから再起動してください（無いとAPIが起動しません）。`OIDC_ADMIN_GROUP`だけの設定は、そのまま同じ全体管理者の判定になります。

### Userと全体roleの同期規則

- 初回SSOでUserをJIT作成します。self-signupの画面はありません。
- `OIDC_ALLOWED_GROUPS`のどのgroupにも入っていない人は拒否し、Userも作りません。
- loginのたびに、全体管理者かどうか（`users.is_admin`）を対応表から同期します。複数groupに該当すれば強い方（`admin`）になります。
- loginのたびに、その人のgroupを`user_groups`へ保存し直します。ProjectのSSO group bindingはこの表を使います。
- 同期で有効な全体管理者（Local Adminを含む）が0人になる場合は、そのloginを拒否し、`is_admin`を残します。
- 既存Local Userへのemail自動連携は既定で無効で、同じemailでも別のUserになります。有効にした場合も`email_verified=true`かつemail一致（大文字小文字を区別しない）で、まだSSOと結び付いていないLocal Userが1人だけのときに限ります。全体管理者やどこかのProject adminであるLocal Userは自動連携しません。
- `email_verified`がtrueでないloginは拒否します。
- SSO由来の表示名とemailはloginのたびに更新します。Local UserのユーザーIDは連携後も維持します。
- 作成・連携、全体roleやgroupの変化は監査ログの`auth.oidc.sync`に残ります。

Role同期を使う環境では、SSO Userの全体roleを画面から一時的に変えても次回ログインでAuthentik側の状態へ戻ります。恒久変更はAuthentik groupで行います。

groupの判定と全体roleの同期はloginのときにだけ行います。Authentik側でgroupから外しても、loginしているsessionは期限（`AUTH_SESSION_ABSOLUTE_SECONDS`、既定12時間）まで元の権限のままです。

Web sessionはHttpOnly/SameSite=Lax cookieで、期限は上の`AUTH_SESSION_*`に従います。変更操作はOriginを検証します。アプリからのlogoutはアプリsessionを失効させます。Authentik全体のsession logout、SCIM、back-channel logoutは提供しません。

### SSOで入れないときの切り分け

callbackで断ったときは、利用者には理由を区別せず401を返します。理由はAPIの標準エラー出力の1行JSON（`{"event":"oidc_login_denied","reason":"<reason>","userId":...}`）と、監査ログの`auth.oidc.denied`（`details.reason`、`details.subject`、`details.email`）に残ります。全体の監査ログは全体管理者が`GET /api/audit-events?action=auth.oidc.denied`で読めます。tokenやcodeは出しません。

| `reason` | 意味 | 直し方 |
|---|---|---|
| `group_not_allowed` | `OIDC_ALLOWED_GROUPS`のどのgroupにも入っていない | Authentikでgroupに入れる。ID tokenに`groups`が出ているかも確認する |
| `email_not_verified` | ID tokenの`email`が無いか、`email_verified`がtrueでない | Authentikでemailを検証済みにし、scope mappingで`email_verified`を出す |
| `user_disabled` | アプリでそのUserが無効になっている | 全体管理者がUserを有効に戻す |
| `last_admin` | groupの同期で、最後の有効な全体管理者を外そうとした | 別の全体管理者（Local Adminでもよい）を先に用意する |
| `privileged_link_required` | 自動連携が有効で、検証済みemailが特権を持つLocal Userと一致した | 乗っ取りを防ぐため自動では連携しない。管理者がLocal Userの権限を確認して対応する |

これ以外の401（`event`が`oidc_authentication_failed`の行や、監査ログ`auth.login`の`details.reason`が`invalid_oidc_state`）は、IdPとの通信、stateの期限切れ、開始したbrowserとの不一致などの問題です。

### 接続元とメンバーの登録

LAN/VPNから使う場合は`MMT_ALLOW_PRIVATE_ORIGINS=true`を設定します。CORS、ログイン/logout、sessionの変更操作で同じ判定を使い、HTTP(S)のIPv4 private・loopback・link-local・CGNAT、IPv6 ULA・loopback・link-localとlocalhostを許可します。設定省略時はfalseです。DNS名で使う場合は`MMT_WEB_ORIGIN`と`MMT_PUBLIC_URL`へ実際のURLを設定してください。Originが欠落/nullの場合や、許可されていないpublic IP・DNS名は拒否します。Bearer API tokenは従来どおりOriginなしで使えます。

開発Webはport5182でLANから接続できます。`/api`はloopbackのAPI4182へproxyします。Authentikのcallbackは`MMT_PUBLIC_URL`の固定URLを使うので、SSOで使うURLはProviderにも完全一致で登録します。

初回に管理者がloginしProjectを作成します。メンバー（`OIDC_ALLOWED_GROUPS`のgroupに入っている人）は一度SSOでloginするとユーザーIDが作られ、Projectの設定からviewer/editor/adminを付けられます。人ごとに付ける代わりに、AuthentikのgroupへProjectのroleを付けることもできます（次の節）。API tokenは発行時のscopeに加え、その所有者の現在のProject権限を確認します。

### 権限の決まり方

権限は2段です。

| 段 | 決め方 | 変える場所 |
|---|---|---|
| 全体role（全体管理者か否か） | `OIDC_ROLE_MAPPING_JSON`（と`OIDC_ADMIN_GROUP`）の対応表。loginのたびに同期 | API serverの環境変数とAuthentikのgroup |
| Project role（viewer/editor/admin） | 直接付与とgroup bindingのうち強い方 | Projectの設定画面（Project admin） |

- 直接付与はユーザー1人に付けるrole（`project_members`）、group bindingはAuthentikのgroup名に付けるrole（`project_group_bindings`）です。どちらもProject adminが設定し、監査ログに`project.member.set`・`project.member.delete`・`project.group_binding.set`・`project.group_binding.delete`として残ります。
- 実効roleは、直接付与と、その人が入っているgroupのbindingのうち最も強いroleです。直接viewer＋group editorならeditorです。判定はすべてDBのview `effective_project_roles`で行い、画面・native API・MLflow互換API・API token・Job tokenで同じ結果になります。Job tokenはRunの作成者の実効roleで判定します。
- 直接付与を外しても、group bindingのroleは残ります。メンバー一覧の`directRole`と`groups`で、どこから付いたroleかを確認できます。
- 全体管理者はbrowser sessionならどのProjectもadminとして操作できます。API tokenでは全体管理者でもProject roleが必要です。
- Projectには、直接付与のadminかadminのgroup bindingが常に1つ以上必要です。最後の1つを外す・下げる操作は409になります。adminのgroup bindingは、そのgroupに入っている人がまだいなくても数えます（そのgroupの人は次のloginで反映されます）。

### Authentik側のgroupの運用

- ProjectごとにAuthentikのgroupを作り（例: `mmt-proj-asr-editors`）、Projectの設定でそのgroupにroleを付けます。group名は大文字小文字・空白も含めて完全一致です。
- ID tokenの`groups`はすべて`user_groups`へ保存するので、bindingに使うgroupを`OIDC_ALLOWED_GROUPS`に入れる必要はありません。ただし、そのgroupの人も許可groupのどれかに入っていないとloginできません。
- groupの所属はloginのときに`user_groups`へ同期します。Authentikでgroupに入れた人は、次のloginから権限が付きます。外した人は、次のloginで権限が外れ、そのgroupの権限だけで使っていたProject限定API tokenも401になります（tokenは失効させないので、groupに戻せば再び使えます）。loginしないまま使い続けているsessionとtokenは、次のloginまで元のgroupのままです。すぐ止めたい場合はProjectの設定で直接付与・bindingを外すか、tokenを失効させます。
- Projectの設定画面のgroup候補（`GET /auth/groups`）には、一度でも誰かのloginで同期されたgroup名だけが出ます。まだ誰もloginしていないgroupは名前を直接入力します。

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
- `MMT_MLFLOW_MULTIPART_UPLOADS`（既定true）は、MLflow SDKのmultipart upload（`mpu/create`→partのPUT→`complete`）を受け付けるかです。falseにするとserver-infoが`multipart_uploads_enabled: false`を返し、`mpu/*`は501を返してSDKを1回のPUTへ戻します。開いているsessionは、falseにした後も登録まで進みます。
- `MMT_UPLOAD_FINALIZE_WAIT_MS`（既定100000）は、MLflowの`mpu/complete`がArtifactの検証・登録を待つ時間です。SDKの既定timeout（120秒）より短くしています。超えると503を返しますが、検証は続き、終われば一覧に出ます。数十GBのファイルを扱う環境では、SDK側の`MLFLOW_HTTP_REQUEST_TIMEOUT`と合わせて大きくします。
- `MMT_MLFLOW_MULTIPART_DOWNLOADS`（既定false）は変えないでください。presigned URLでの取得は作っていないので、trueにするとMLflow 3.17以降のSDKのdownloadが失敗します。
- MLflowのpartのURLは、リクエストのHostと`X-Forwarded-Proto`から組み立てます。前段proxyは`Host`を書き換えず、TLSを終端するなら`X-Forwarded-Proto`を渡してください（同梱の`deploy/nginx.conf`はどちらも設定済み）。

### 配信

- `GET /projects/:p/artifacts/:a/content`は`ETag: "sha256-<hex>"`と`Cache-Control: private, max-age=31536000, immutable`を返します。`If-None-Match`が一致すれば304、`If-Range`が一致しなければRangeを無視して200です。MLflow経路のdownloadはpathの付け替えがあるため`no-store`のままです（ETagは同じ形式）。
- upload時のContent-Typeが空か`application/octet-stream`なら、拡張子からMIMEを推定します（wav、flac、mp3、ogg、opus、m4a、aac、webm、mp4、mov、png、jpg、webp、avif、gif、csv、tsv、jsonl、txt、npy、parquet）。HTML・SVG・XML・JSは推定しません。既存のArtifactのMIMEは書き換えません。

### Artifact保存先の全体設定

- 保存先は全体管理者が `/admin/storage-backends`（画面は storage-backend-admin-web の /admin）で追加する。種類は filesystem と S3。S3 は endpoint、region、bucket、prefix、path-style、署名（v4。v2 は第4波から）、TLS 検証と CA、checksum の扱い（既定 WHEN_REQUIRED）、単一PUTの part size（5MiB〜512MiB、既定8MiB）を設定する。
- 環境変数（`ARTIFACT_FILESYSTEM_ROOT`、`S3_*`）由来の `filesystem` と `s3` は従来どおり使え、画面では読み取り専用で表示される。DB へは写さない。
- secret を持つ S3 保存先を作るには `MMT_STORAGE_SECRET_KEY`（base64 の 32 byte）を API の環境に設定する。生成例: `openssl rand -base64 32`。値は `.env` だけに置き、worklog やチケットへ書かない。
- **鍵を変えると、保存済みの secret は復号できなくなる。** 起動時に `storage_backend_unavailable`（名前と理由だけ）がログに出て、その保存先の Artifact は 503 になる。鍵を変えたら、各 S3 保存先の secret を PATCH で入れ直す（鍵の自動ローテーションは未実装）。
- 新しい保存先は、作成後に「接続テスト」（put/get/range/delete を `mmt-connection-test/<uuid>/` で実施）で確かめてから既定にする。
- 既定の保存先（`/admin/storage-settings`）は新規Projectの作成フォームの初期選択だけを変える。既存Projectの保存先は Project 設定で個別に変える。既存Artifactは保存時の保存先から読み続ける。
- 保存先をやめるときは `enabled:false` にする（既存Artifactは読めるが、新規保存は拒否）。既定のままでは無効にできないので、先に既定を切り替える。Artifact が参照している保存先の種類・bucket・endpoint・prefix・rootPath は変えられない（409）。
- DB 上の S3 保存先の実機確認: `MMT_VERIFY_S3_BACKEND=<名前> MMT_DATABASE_URL=... MMT_STORAGE_SECRET_KEY=... MMT_VERIFY_S3_CONFIRM=write-and-delete npx tsx scripts/verify_s3_artifacts.ts`。結果は `artifacts/verification/<日付>/s3/` に値を含めずに出る。
- API プロセスが複数ある構成では、設定変更は変更を受けたプロセスで即時に効き、他のプロセスは未知の保存先名を読んだときに読み直す。有効/無効や part size の変更を全プロセスへ確実に反映するには API を再起動する。

### 音声Artifactのmedia情報

- WAV（`audio/wav`・`audio/x-wav`・`audio/wave`）と FLAC（`audio/flac`・`audio/x-flac`）の Artifact は、登録時に保存先から先頭 64KiB を Range で読み、長さ・sample rate・チャンネル数・bit 数・codec を `artifact_media_info` に保存する（migration 029）。ffmpeg などの追加依存は無い。
- 読み込みや解析に失敗しても Artifact の登録は成功する。API ログに `{"event":"artifact_media_info_failed","artifactId":…,"projectId":…,"name":…}` が出る。保存先の場所や SQL の詳細は出さない。多発する場合は、保存先の Range 読み込み（S3 の GetObject Range、filesystem の読み取り権限）を確認する。
- この機能より前に登録した Artifact には media 情報が無い（API は 404、Web は decode 後の値だけを表示）。必要になったら、`mime_type` が上記で `artifact_media_info` に行の無い Artifact を対象に、同じ `recordArtifactMediaInfo` を呼ぶ一括処理を後から足す（今回は作っていない）。
- MP3・Ogg・m4a などは第4波 server-preview-derivatives の ffprobe（`source='ffprobe'`）で扱う。

## SSH/GPU worker

workerはAPI serverとは別processです。SSH秘密鍵とknown_hostsはworkerのfilesystemに置き、ComputeTargetにはパスだけ登録します。known_hostsの確認を無効にしません。接続先のPythonとvenv/pip、コードが必要とするCUDA/driverは実行先に用意してください。鍵・tokenをCodeVersion.environmentへ書かないでください。

workerにはProject限定のService Account tokenを渡します。`read`、`worker:execute`、コードsnapshotを保存する`artifacts:write`を付けます。実行中コードのSDKが記録する場合は`runs:write`、モデルやデータセットを登録する場合は`registry:write`も必要です。詳細は[worker手順](worker.md)を参照してください。

GPU予約はこのアプリ内のJob間で排他にします。ほかのSSH shellや別schedulerが同じGPUを使うことまでは防げません。共有GPUではアプリ専用のGPU一覧・作業directoryを設定してください。

worker identityとstate directoryは再起動後も保持します。APIやSSHの応答が失われても、実行状態を確認するまで同じJobを二重起動しません。状態未確認のJobのGPUを自動解放しません。停止要求後はworkerから終了が報告されてから再実行します。

## workerホストへworkerを導入する

APIサーバーはworkerホストへSSHしない（decisions.md）。導入・更新・状態確認は、workerホスト上で `mado-tracking-worker` CLI を使う。常駐はsystemdが正、Docker composeは補助。

### 1. tokenを用意する

Project限定のservice tokenを、scope `read`・`worker:execute`・`artifacts:write` で発行する（`POST /tokens`、kind=`service`）。
第4波（auth-service-accounts）以降は、人に紐付かないService Accountのkeyを使う（期限上限365日）。予定どおりに入ったら、この節の発行手順をService Accountの画面・APIに置き換える。

### 2. venvへ入れてinstallする（user unit）

```bash
python3 -m venv ~/.local/share/mado-tracking-worker/venv
~/.local/share/mado-tracking-worker/venv/bin/pip install 'mado-tracking[telemetry]'   # 社内配布先かwheelのpath
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker install \
  --api-url https://tracking.example.internal \
  --worker-id gpu-host-1 \
  --target-ids "<target-uuid>"
# tokenは端末なら非表示の入力、パイプなら標準入力、または --token-file で渡す。引数には書かない
loginctl enable-linger "$USER"   # ログアウト後も動かす場合
```

installがすること:
- `~/.config/mado-tracking-worker/<worker-id>.env` を mode 600 で書く（API URL、worker ID、target、state directory、token）。
- `~/.config/systemd/user/mado-tracking-worker@.service` を書き、`systemctl --user daemon-reload` → `enable --now mado-tracking-worker@<worker-id>.service`。
- state directoryの既定は、手で起動していたworkerと同じ `~/.local/state/mado-tracking-worker/<sha256(worker-id)の先頭16桁>`。手動起動から移るときも実行中Jobのjournalを引き継ぐ。別の場所なら `--state-dir`。
- worker IDは英数字・`.`・`_`・`-`の64文字まで（systemdのinstance名とファイル名に使うため）。

system unitにする場合は root で `--systemd-system --service-user <account>`。env fileは `/etc/mado-tracking-worker/<id>.env`（root、600）、stateは `/var/lib/mado-tracking-worker/<id>`（service userの所有、700）。手で置く場合の雛形は `deploy/worker/mado-tracking-worker@.service` と `deploy/worker/worker.env.example`。

unitは `Restart=on-failure`、`KillMode=process`。worker自身の再起動・停止・upgradeでは、detachされた実行中Jobを止めない（再起動後のworkerがjournalから回収する）。Jobを止めるのはcancel APIだけ。

### 3. 確かめる

```bash
mado-tracking-worker doctor --worker-id gpu-host-1 [--ssh-key <targetのsshKeyPath>] [--known-hosts <knownHostsPath>]
mado-tracking-worker status --worker-id gpu-host-1     # unit状態、worker lock、保持中Job。止まっていれば終了コード3
journalctl --user -u mado-tracking-worker@gpu-host-1 -f
```

doctorは、env fileとstate directoryのmode、APIへの到達（`/api/health`）、tokenのscope（`GET /api/auth/token`。Job tokenは不可）、`~/.ssh`・秘密鍵（group/otherの権限なし）・known_hosts（group/other書き込み不可）を確かめる。errorがあれば終了コード1。Compute画面の「Workers」に版とホスト名が出ることも確認する。

### 4. 更新する

```bash
mado-tracking-worker upgrade --worker-id gpu-host-1 --version 0.2.0
# 配布先がPyPI形式でなければ --package-spec /path/to/mado_tracking-0.2.0-py3-none-any.whl
```

unitのExecStartにあるvenvへ `pip install --upgrade` してから `systemctl restart`。実行中Jobとjournalはそのまま。unitが止まっているのに別のworkerがstate directoryのlockを持っている（手で起動したworkerが残っている）場合は、何もせず止まる。pipが失敗したら再起動しない。

### Docker composeで動かす（補助）

SSH targetだけを使うworkerは `docker compose --profile worker up -d worker` でも動かせる。
- token: `MMT_WORKER_TOKEN_FILE`（既定 `./var/worker-token`）をDocker secretとして `/run/secrets/mmt_worker_token` に渡す。
- 鍵とknown_hosts: `MMT_WORKER_SSH_DIR`（既定 `./var/worker-ssh`）を `/home/worker/.ssh` にread-onlyでmountする。targetの `sshKeyPath`・`knownHostsPath` はcontainer内のpathで登録する。鍵の所有者に合わせて `MMT_WORKER_UID`/`MMT_WORKER_GID` でbuildする。
- state: volume `worker-state`。消すと実行中Jobを回収できなくなる。
- `MMT_WORKER_ID`（既定 `compose-worker-1`）、`MMT_WORKER_API_URL`（既定 `http://api:4182`）、`MMT_WORKER_TARGET_IDS`。
- local executorのJobはcontainerと一緒に止まるため、composeでは使わない。
- 確認は `docker compose --profile worker run --rm worker doctor`。

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
