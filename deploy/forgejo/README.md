# 同梱のForgejo（git repo、mirror、container registry）

ジョブの雛形とコードのgit repo、外部とのmirror、container registryに、Forgejoを使います（[設計案](../../docs/design/external-execution.md)「コードとimage」）。`compose.yml`の`forgejo`（profile `forge`）は、公式のrootless image（`codeberg.org/forgejo/forgejo:16.0.5-rootless`、uid 1000で動く）を使います。ForgejoはGPLv3以降のソフトウェアで、手を加えずに別のサービスとして動かします。

## 設定する値

`.env`（composeの変数）に置きます。秘密の値はここに書きません。

| 変数 | 既定 | 内容 |
|---|---|---|
| `MMT_FORGEJO_DOMAIN` | `forge.example.org` | 公開URLのhostname。`ROOT_URL`は`https://<この値>/`、imageの名前は`<この値>/<owner>/<image>`になります |
| `MMT_FORGEJO_HTTP_PORT` | `3000` | TLSのreverse proxyからつなぐloopbackのport |
| `MMT_FORGEJO_SSH_BIND` | `127.0.0.1` | git over SSHを受けるアドレス。利用者のPCから使うときはLANのアドレスにします |
| `MMT_FORGEJO_SSH_PORT` | `2222` | git over SSHのport。clone URLにもこの番号が出ます |
| `MMT_FORGEJO_SSH_DOMAIN` | `MMT_FORGEJO_DOMAIN` | clone URLに出すSSHのhostname |
| `MMT_FORGEJO_SECRET_KEY_FILE` | `./var/forgejo-secret-key` | Forgejoの`SECRET_KEY`を入れたファイル（Docker secret） |

ほかの設定は`compose.yml`の`FORGEJO__<section>__<KEY>`で、起動のたびに`app.ini`へ書かれます。

- 登録は、Authentik（OIDC）での初回ログインだけです（`ALLOW_ONLY_EXTERNAL_REGISTRATION`、`ENABLE_AUTO_REGISTRATION`）。username はAuthentikの`preferred_username`です。同じ名前やemailのアカウントがあれば、ログインして結び付けます（`ACCOUNT_LINKING=login`）。
- ログインしないと何も見えません（`REQUIRE_SIGNIN_VIEW`）。
- DBはSQLiteで、repo、package（container image）、`app.ini`とともにvolume `forgejo-data`に入ります。利用者やimageが多くなったら、PostgreSQLに切り替えます（`FORGEJO__database__DB_TYPE=postgres`など）。

## 起動

1. `SECRET_KEY`を作ります。containerはuid 1000で読むので、所有者を合わせます。鍵が無いと、Forgejoは公開されている既定値を使ってしまいます。失うと2要素認証の情報などを復号できなくなるので、backupに含めます。

   ```bash
   install -d -m 700 var
   (umask 077 && openssl rand -hex 32 > var/forgejo-secret-key)
   sudo chown 1000:1000 var/forgejo-secret-key && sudo chmod 400 var/forgejo-secret-key
   ```

2. 起動して、healthcheckが通るのを待ちます。

   ```bash
   docker compose --profile forge up -d forgejo
   docker compose --profile forge ps forgejo     # (healthy)
   ```

3. TLSのreverse proxyで、`https://<MMT_FORGEJO_DOMAIN>/`を`127.0.0.1:<MMT_FORGEJO_HTTP_PORT>`へ転送します。registry（`/v2/`）のimageの層は大きいので、本文の上限を外し、bufferしないようにします。

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto https;
       proxy_set_header X-Forwarded-For $remote_addr;
       client_max_body_size 0;
       proxy_request_buffering off;
       proxy_read_timeout 600s;
   }
   ```

   Docker clientはHTTPSのregistryしか使わないので、このproxyが要ります。Forgejoのhostnameはintranetだけで使い、[runner用のedge](../edge/README.md)とは分けます。

4. 最初の管理者を作ります。ここで表示されるpasswordは一度しか出ません。最初のログインで変更を求められます。SSOが止まったときの経路として残します。

   ```bash
   docker compose --profile forge exec forgejo forgejo admin user create \
     --admin --username forge-admin --email admin@example.org --random-password --must-change-password
   ```

## Authentikでログインする（OIDC）

client secretをcommand lineやrepoに書かないよう、ログイン元はForgejoの管理画面で登録します。

1. AuthentikでOAuth2/OpenID Providerを作ります（client typeはConfidential）。
   - Redirect URI: `https://<MMT_FORGEJO_DOMAIN>/user/oauth2/authentik/callback`（末尾の`authentik`は、次の手順の名前と同じにします）
   - Scope: `openid`、`email`、`profile`（Authentikの`profile`には`groups`が入ります）
   - Applicationのslugを`forgejo`にすると、issuerは`https://sso.example.com/application/o/forgejo/`です。
2. Forgejoに管理者でログインし、サイト管理（Site administration）の認証ソース（Authentication sources）で、認証ソースを追加（Add authentication source）します。表示の言語によって項目名が変わるので、英語の名前も添えます。
   - 認証タイプ（Authentication type）: OAuth2、名前（Authentication name）: `authentik`、プロバイダー（OAuth2 provider）: OpenID Connect
   - クライアントID（Client ID）とクライアントシークレット（Client secret）: Authentikの値
   - 自動検出URL（OpenID Connect Auto Discovery URL）: `https://sso.example.com/application/o/forgejo/.well-known/openid-configuration`
   - 追加のスコープ（Additional scopes）: `email profile`
   - グループのクレーム名（Claim name providing group names）: `groups`。管理者にするグループ（Group claim value for administrator users、例: `forgejo-admins`）と、制限付きにするグループは必要に応じて入れます
   - Authentikで多要素認証をしているなら、ローカルの2要素認証の省略（Skip local 2FA）を選べます
3. ログイン画面に「authentikでサインイン」が出ます。初回のログインでアカウントができます。

command lineで登録するときは`forgejo admin auth add-oauth --name authentik --provider openidConnect ...`ですが、`--secret`の値がprocessの引数に残るので、管理画面を勧めます。

## container registry

- imageの名前は`<MMT_FORGEJO_DOMAIN>/<owner>/<image>:<tag>`です（ownerはユーザーか組織）。
- SSOのユーザーにはForgejoのpasswordが無いので、push・pullには個人のアクセストークンを使います（設定（Settings）のアプリケーション（Applications）で作ります。pushは`write:package`、pullは`read:package`）。

  ```bash
  docker login forge.example.org -u <username>      # passwordにアクセストークンを入れる
  ```

- コンピュータがimageを取得するときは、取得用のユーザー（bot）を作り、`read:package`だけのtokenを発行します。launcherの`registry_secret_file`（`{"username": "...", "password": "<token>"}`、mode 600）に置くと、runnerが`apptainer pull`や`docker pull`に使います。
- multi-archのbuildとpushは[base imageの説明](../../images/base/README.md)にあります。

## mirror

- 新しいマイグレーション（New migration）で外部のrepoを取り込むときにミラー（mirror）を選ぶと、定期的に同期します（pull mirror）。外部へ送る場合は、repoの設定のミラー設定（Mirror settings）でpush mirrorを足します。
- LANの中のgitサーバーからmirrorするときは、`FORGEJO__migrations__ALLOW_LOCALNETWORKS: 'true'`を足します（既定ではprivateアドレスへの接続を拒みます）。

## backup

volume `forgejo-data`（repo、package、SQLite、`app.ini`）と`SECRET_KEY`のファイルを一緒に保存します。止めずに取るときは`forgejo dump`を使います。dumpはvolumeの外（container の`/tmp`）に書き、取り出してから消します。

```bash
docker compose --profile forge exec forgejo forgejo dump --file /tmp/forgejo-dump.zip
docker compose --profile forge cp forgejo:/tmp/forgejo-dump.zip ./forgejo-dump.zip
docker compose --profile forge exec forgejo rm /tmp/forgejo-dump.zip
```

## 更新

`compose.yml`のimageのtagを変えて`docker compose --profile forge up -d forgejo`します。major versionを上げるとき（16から17など）は、Forgejoのrelease notesの手順を先に確かめ、backupを取ってからにします。
