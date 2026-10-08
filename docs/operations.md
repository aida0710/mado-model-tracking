# 運用と接続設定

## Authentik

AuthentikにOAuth2/OpenID ProviderとApplicationを用意します。client secretはAPI serverにだけ設定します。Redirect URIには`https://<アプリのホスト>/api/auth/callback`を完全一致で登録し、per-providerのissuerを使います。Providerの設定方法は[Authentik公式資料](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)を参照してください。

API server側の設定:

```dotenv
NODE_ENV=production
AUTH_MODE=oidc
MMT_PUBLIC_URL=https://tracking.example.com
MMT_WEB_ORIGIN=https://tracking.example.com
OIDC_ISSUER_URL=https://sso.example.com/application/o/model-tracking/
OIDC_CLIENT_ID=<providerのclient ID>
OIDC_CLIENT_SECRET=<secret>
OIDC_ADMIN_GROUP=mmt-admins
```

アプリはAuthorization Code＋PKCE、state、nonce、ID tokenの署名・issuer・audienceを検証します。`openid profile email`を要求し、`email_verified=true`が必要です。Authentik側のscope mappingから必要なclaimをID tokenへ出してください。`groups`配列に`mmt-admins`がある利用者だけが全体管理者になります。Project内の権限はアプリで個別に設定します。

Web sessionはHttpOnly/SameSite=Lax cookieで12時間。変更操作はOriginを検証します。アプリからのlogoutはアプリsessionを削除します。Authentik全体のsession logout、SCIM、back-channel logoutは提供しません。

LAN/VPNから使う場合は`MMT_ALLOW_PRIVATE_ORIGINS=true`を設定します。CORS、ログイン/logout、sessionの変更操作で同じ判定を使い、HTTP(S)のIPv4 private・loopback・link-local・CGNAT、IPv6 ULA・loopback・link-localとlocalhostを許可します。設定省略時はfalseです。DNS名で使う場合は`MMT_WEB_ORIGIN`と`MMT_PUBLIC_URL`へ実際のURLを設定してください。Originが欠落/nullの場合や、許可されていないpublic IP・DNS名は拒否します。Bearer API tokenは従来どおりOriginなしで使えます。

開発Webはport5182でLANから接続できます。`/api`はloopbackのAPI4182へproxyします。Authentikのcallbackは`MMT_PUBLIC_URL`の固定URLを使うので、SSOで使うURLはProviderにも完全一致で登録します。

初回に管理者がloginしProjectを作成します。メンバーは一度SSOでloginするとユーザーIDが作られ、Projectの設定からそのIDでviewer/editor/adminを付けられます。API tokenは発行時のscopeに加え、その所有者の現在のProject membershipを確認します。

## Artifacts

ファイルシステムは`ARTIFACT_FILESYSTEM_ROOT`配下に、API serverだけが読める権限で保存します。サーバー生成IDを保存キーにし、利用者のファイル名は表示用metadataとして扱います。API server間で共有する場合は同じ永続volumeが必要です。

S3は`S3_BUCKET`を設定するとProjectの保存先に選べます。`S3_ENDPOINT`未指定ならAWS S3です。互換サービスでは`S3_ENDPOINT`と必要に応じて`S3_FORCE_PATH_STYLE=true`を設定します。AWS SDKの標準credential provider、または対になった`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`を使います。必要権限は対象prefix内のPut/Get/Delete、multipart uploadとabortです。

保存先の変更は以後のuploadに効きます。既存Artifactは保存したbackendを記録しているので、元のストレージも読み取り可能な状態にします。uploadはstreamingでSHA-256を計算し、DB登録に失敗したblobを削除します。mediaのseekはHTTP Rangeを使います。HTML/SVG等はダウンロード扱いにします。

DBとArtifactsは同時点でバックアップします。DBだけのrestoreでは重み・画像・音声を戻せません。

## SSH/GPU worker

workerはAPI serverとは別processです。SSH秘密鍵とknown_hostsはworkerのfilesystemに置き、ComputeTargetにはパスだけ登録します。known_hostsの確認を無効にしません。接続先のPythonとvenv/pip、コードが必要とするCUDA/driverは実行先に用意してください。鍵・tokenをCodeVersion.environmentへ書かないでください。

workerにはProject限定のService Account tokenを渡します。`read`、`worker:execute`、コードsnapshotを保存する`artifacts:write`を付けます。実行中コードのSDKが記録する場合は`runs:write`、モデルやデータセットを登録する場合は`registry:write`も必要です。詳細は[worker手順](worker.md)を参照してください。

GPU予約はこのアプリ内のJob間で排他にします。ほかのSSH shellや別schedulerが同じGPUを使うことまでは防げません。共有GPUではアプリ専用のGPU一覧・作業directoryを設定してください。

worker identityとstate directoryは再起動後も保持します。APIやSSHの応答が失われても、実行状態を確認するまで同じJobを二重起動しません。状態未確認のJobのGPUを自動解放しません。停止要求後はworkerから終了が報告されてから再実行します。

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
