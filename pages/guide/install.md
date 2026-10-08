---
title: インストール
description: Docker ComposeでMado Model Trackingを起動する。PostgreSQL、.envの主要な変数、migration、初期管理者、WebとAPIのURL、workerの導入までの流れ。
---

# インストール

Mado Model Trackingは、Docker ComposeでWeb、API、PostgreSQL、音声・動画のプレビューを作るpreview workerを起動します。学習や推論のJobを実行するworkerは、GPUのあるworkerホストへ別に導入します。

| コンテナ | 役割 |
| --- | --- |
| `web` | 画面を配信し、`/api/`をAPIへ中継するnginx。ホストの`127.0.0.1:5182`で待ち受けます |
| `api` | API。MLflow 3互換API、自動実行、Artifactの回収もこのプロセスが行います |
| `postgres` | PostgreSQL 16。データはvolume `postgres`に保存します |
| `preview` | 長い音声や動画の波形・スペクトログラムを作ります（ffmpeg入り） |

## 必要なもの

- Linuxのサーバー（以下はUbuntuでの例）
- Docker EngineとDocker Compose v2
- HTTPSで公開するためのDNS名と、TLSを終端するリバースプロキシ

composeの`api`は`NODE_ENV=production`で動くため、公開URLは`https://`でないと起動しません。`web`はホストの`127.0.0.1:5182`だけで待ち受けるので、前段にTLSを終端するリバースプロキシを置きます。

Dockerがまだ無い場合は、ターミナルで次を実行します。

```sh
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker "$USER"
```

一度ログアウトしてログインし直してから、次のコマンドでバージョンが表示されることを確認します。

```sh
docker compose version
```

## 1. リポジトリを取得する

```sh
git clone https://github.com/aida0710/mado-model-tracking.git
cd mado-model-tracking
```

## 2. .envを作る

`.env.example`を元に`.env`を作ります。`.env`はシークレットを含むので、所有者だけが読める権限にします。

```sh
cp .env.example .env
chmod 600 .env
```

鍵とパスワードを作ります。次のコマンドを実行し、表示された値をそれぞれ`.env`へ書きます。値をチャットやチケットに貼らないでください。

```sh
openssl rand -hex 24      # MMT_POSTGRES_PASSWORD
openssl rand -base64 32   # MMT_STORAGE_SECRET_KEY
openssl rand -base64 32   # MMT_SESSION_ENCRYPTION_KEY（SSOを使う場合。上とは別の値）
```

`.env`で主に設定する変数は次のとおりです。

| 変数 | 入力する値 | 説明 |
| --- | --- | --- |
| `MMT_POSTGRES_PASSWORD` | 上で作った値 | PostgreSQLのパスワード。`.env.example`には無いので末尾に足します。composeがこの値でDBの接続先を組み立てます |
| `MMT_PUBLIC_URL` | `https://tracking.example.com` | 利用者が開くURL。SSOのcallbackにも使います |
| `MMT_WEB_ORIGIN` | `MMT_PUBLIC_URL`と同じ値 | 画面のorigin。変更操作のOriginの検証に使います |
| `MMT_STORAGE_SECRET_KEY` | 上で作った値 | 画面から追加するS3保存先のシークレットを、DBで暗号化する鍵 |
| `MMT_ARTIFACT_MAX_BYTES` | 既定のまま（200GiB） | Artifact 1件の上限 |
| `MMT_ALLOW_PRIVATE_ORIGINS` | `true`または`false` | `true`にすると、LANやVPNのprivate IPのURLからも操作できます |

SSO（Authentik）を使う場合は、次も設定します。Authentik側の設定は[AuthentikでSSO](/admin/sso)を参照してください。

| 変数 | 入力する値の例 |
| --- | --- |
| `OIDC_ISSUER_URL` | `https://sso.example.com/application/o/model-tracking/` |
| `OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET` | AuthentikのProviderに表示される値 |
| `OIDC_ALLOWED_GROUPS` | `mmt-users,mmt-admins`（ログインを許すgroup） |
| `OIDC_ROLE_MAPPING_JSON` | `{"mmt-admins":"admin","mmt-users":"user"}`（全体管理者にするgroup） |
| `MMT_SESSION_ENCRYPTION_KEY` | 上で作った値 |

`.env.example`の`MMT_DATABASE_URL`、`HOST`、`PORT`、`ARTIFACT_FILESYSTEM_ROOT`、`AUTH_MODE`は、composeの`api`では`compose.yml`の値が優先されます。書き換える必要はありません。変数の一覧は[環境変数](/reference/environment)にあります。

## 3. 認証方式を選ぶ

`compose.yml`は`api`の`AUTH_MODE`を`oidc`（SSOだけ）にしています。初めて導入するときは、緊急用のローカル管理者でもログインできる`hybrid`にしておくと安全です。リポジトリの直下に`compose.override.yml`を作り、`AUTH_MODE`を上書きします。

```yaml
services:
  api:
    environment:
      AUTH_MODE: hybrid
```

| `AUTH_MODE` | ログイン方法 | 必要な設定 |
| --- | --- | --- |
| `hybrid` | SSOとローカルアカウント | `OIDC_*`と`MMT_SESSION_ENCRYPTION_KEY` |
| `oidc` | SSOだけ | `OIDC_*`と`MMT_SESSION_ENCRYPTION_KEY` |
| `local` | ローカルアカウントだけ | なし（SSOが無い環境） |

`docker compose`は`compose.override.yml`を自動で読みます。次のコマンドで`AUTH_MODE`が置き換わっていることを確認します。

```sh
docker compose config | grep AUTH_MODE
```

## 4. 起動してmigrationを適用する

イメージを作り、DBを起動してからmigrationを適用します。migrationはAPIの起動時には走らないので、初回と更新のたびに実行します。

```sh
docker compose build
docker compose up -d postgres
docker compose run --rm api npm run db:migrate -w @mmt/api
```

`Migration complete`と表示されれば完了です。その前に出る`../../.env not found. Continuing without it.`は、コンテナの中に`.env`を置いていないことを示すだけで、問題ありません（設定はcomposeがコンテナへ渡しています）。続けて残りのコンテナを起動します。

```sh
docker compose up -d
docker compose ps
```

`STATUS`がすべて`Up`で、`postgres`には`(healthy)`が付いていることを確認します。APIの応答は次のコマンドで確かめます。

```sh
curl -fsS http://127.0.0.1:5182/api/health
```

`{"status":"ok"}`が返れば、Webの中継とAPIの両方が動いています。起動しない場合は`docker compose logs api`を確認します。設定が足りないときは、足りない変数の名前がログに出ます。

## 5. 初期管理者を作る

`hybrid`または`local`では、ローカルアカウントの全体管理者を作ります。ターミナルで次を実行し、ユーザー名とパスワード（12バイト以上）を入力します。パスワードは画面に表示されません。

```sh
docker compose exec api npm run bootstrap-admin -w @mmt/api
```

`Admin ready: <ユーザー名> ...`と表示されれば作成できています。最初のログインでパスワードの変更を求められます。同じユーザー名でもう一度実行すると、パスワードを置き換えて全体管理者に戻せます。パスワードを忘れたときの復旧にも使います。

`oidc`だけで運用する場合は、`OIDC_ROLE_MAPPING_JSON`で`admin`にしたgroupの人が全体管理者になります。

## 6. HTTPSで公開する

リバースプロキシで`MMT_PUBLIC_URL`のDNS名を受け、`http://127.0.0.1:5182`へ転送します。Caddyなら次の設定でTLS証明書の取得と転送ができます。

```txt
tracking.example.com {
	reverse_proxy 127.0.0.1:5182
}
```

ほかのリバースプロキシを使う場合は、次の点を守ります。

- `Host`ヘッダーを書き換えない
- リクエスト本文の上限を設けず、bufferせずに転送する（大きなArtifactのアップロードのため）
- リクエスト全体のtimeoutを設けず、無通信のtimeoutを120秒程度にする

::: warning MLflowのmultipart uploadについて
同梱の`web`コンテナのnginxは、`X-Forwarded-Proto`を自分が受けたscheme（`http`）で上書きします。前段でTLSを終端すると、MLflow SDKのmultipart upload（既定では500MiB以上のファイル）でpartの送り先が`http://`になります。前段が`http://`を`https://`へリダイレクトする構成では、そのuploadが失敗します。大きなファイルをMLflow SDKから送る場合は、`.env`に`MMT_MLFLOW_MULTIPART_UPLOADS=false`を設定すると、SDKが1回のストリーム転送で送ります。
:::

ブラウザで`MMT_PUBLIC_URL`を開き、ログイン画面が表示されることを確認します。`hybrid`ではSSOのボタンも表示されます。

![ユーザー名とパスワードを入力するログイン画面](/images/guide-login.png)

## WebとAPIのURL

| 用途 | URL |
| --- | --- |
| 画面 | `https://tracking.example.com/` |
| 独自API | `https://tracking.example.com/api/` |
| Python SDKの`MMT_API_URL` | `https://tracking.example.com`（`/api`を付けても同じ） |
| MLflowの`MLFLOW_TRACKING_URI` | `https://tracking.example.com/api/mlflow/projects/<ProjectのID>` |
| APIの稼働確認 | `https://tracking.example.com/api/health` |

MLflowの接続先はProjectごとに分かれます。Projectの「Settings」の「MLflow 3から接続」に、そのProjectのURLが表示されます。

## workerを導入する

学習・推論・評価のJobを実行するには、GPUのあるworkerホストへworkerを導入します。API serverはworkerホストへSSHしません。workerホスト上で`mado-tracking-worker`コマンドを使って導入し、systemdで常駐させます。手順は[workerの導入](/compute/worker)を参照してください。

## 更新する

```sh
git pull
docker compose build
docker compose run --rm api npm run db:migrate -w @mmt/api
docker compose up -d
```

DBとArtifactは同じ時点でバックアップしてください。DBだけを戻しても、重みや音声のファイルは戻りません。

## 次に読む

[クイックスタート](/guide/quickstart)で、最初のProjectを作ってRunを記録します。
