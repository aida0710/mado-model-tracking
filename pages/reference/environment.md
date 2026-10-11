---
title: 環境変数
description: API server、preview worker、worker、Python SDK、Mado pluginの環境変数の一覧と既定値。
---

# 環境変数

API serverは、リポジトリの直下の`.env`を読みます。雛形は`.env.example`です。`.env`には認証情報が入るので、`chmod 600 .env`で本人だけが読めるようにし、リポジトリやチャットに貼らないでください。

```sh
cp .env.example .env
chmod 600 .env
```

値を変えたら、APIを再起動します。形式の違う値や、足りない設定があると、APIは設定の名前だけを表示して起動しません。

## API server: 基本

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `MMT_DATABASE_URL` | なし（必須） | PostgreSQLの接続URL。`DATABASE_URL`でも可 |
| `NODE_ENV` | `development` | 本番では`production`。HTTPSのURLが必須になり、開発用の機能が使えなくなる |
| `HOST` | `127.0.0.1` | APIが待ち受けるアドレス |
| `PORT` | `4182` | APIが待ち受けるポート |
| `MMT_PUBLIC_URL` | `http://127.0.0.1:4182` | 利用者が開くURL。SSOのcallbackもこのURLから作る |
| `MMT_WEB_ORIGIN` | `http://127.0.0.1:5182` | 画面のorigin。通知のリンクにも使う |
| `MMT_ALLOW_PRIVATE_ORIGINS` | `false` | `true`にすると、LAN・VPNのprivate IPとlocalhostのoriginも許可する |
| `MMT_ALLOW_SEED` | `false` | 見本データの投入を許す。`AUTH_MODE=development`のときだけ効く |
| `MMT_ALLOW_LOCAL_EXECUTOR` | `false` | local executorを許す。`AUTH_MODE=development`のときだけ効く |
| `DEVELOPMENT_ADMIN_EMAIL` | `admin@localhost` | 開発用ログインで全体管理者になるメールアドレス |

## 認証とSSO

詳しい設定は[認証方式とローカルアカウント](/admin/auth)と[Authentik（SSO）](/admin/sso)を参照してください。

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `AUTH_MODE` | `hybrid` | `local`、`oidc`、`hybrid`、`development` |
| `AUTH_SESSION_IDLE_SECONDS` | `28800`（8時間） | 操作しないままsessionが切れるまでの秒数。300以上 |
| `AUTH_SESSION_ABSOLUTE_SECONDS` | `43200`（12時間） | ログインからsessionが切れるまでの秒数。3600以上で、idle以上 |
| `OIDC_ISSUER_URL` | なし | AuthentikのApplicationのIssuer。`oidc`・`hybrid`で必須。HTTPSのURL |
| `OIDC_CLIENT_ID` | なし | ProviderのClient ID。`oidc`・`hybrid`で必須 |
| `OIDC_CLIENT_SECRET` | なし | ProviderのClient Secret |
| `OIDC_ALLOWED_GROUPS` | なし | ログインを許すgroup（カンマ区切り）。`oidc`・`hybrid`で必須 |
| `OIDC_ROLE_MAPPING_JSON` | なし | group→全体のroleの対応表。例: `{"mmt-admins":"admin","mmt-users":"user"}` |
| `OIDC_DEFAULT_ROLE` | `user` | 対応表のどのgroupにも入っていない人のrole |
| `OIDC_ADMIN_GROUP` | なし | `{"<group>":"admin"}`の省略形。対応表も無ければ`mmt-admins`が全体管理者 |
| `OIDC_SCOPES` | `openid profile email` | 要求するscope。`openid`は必須。refresh tokenを使うなら`offline_access`を足す |
| `OIDC_LABEL` | `Authentik` | ログイン画面のSSOボタンの表示名 |
| `OIDC_AUTO_LINK_VERIFIED_EMAIL` | `false` | 同じメールアドレスのローカルアカウントへ自動で結び付けるか |
| `OIDC_ALLOW_INSECURE_HTTP` | `false` | loopbackのHTTPのIssuerを許す（試験用）。本番では使えない |
| `MMT_SESSION_ENCRYPTION_KEY` | なし | sessionに保存するAuthentikのtokenの暗号鍵（base64の32 byte）。`oidc`・`hybrid`で必須 |
| `OIDC_RECHECK_SECONDS` | `60` | SSOのsessionのgroupを確かめ直す間隔（秒） |
| `OIDC_TOKEN_SYNC_MAX_AGE_SECONDS` | `604800`（7日） | SSOのユーザーのAPI tokenを使える、最後のgroupの同期からの秒数。60以上 |
| `MMT_TOKEN_MAX_LIFETIME_DAYS` | `365` | 新しいAPI tokenの期限の上限（日）。1〜3650 |

暗号鍵はターミナルで作ります。`MMT_SESSION_ENCRYPTION_KEY`と`MMT_STORAGE_SECRET_KEY`には別の値を使ってください。

```sh
openssl rand -base64 32
```

## Artifactと保存先

保存先の設定は[保存先](/data/storage)で詳しく説明します。

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `ARTIFACT_FILESYSTEM_ROOT` | APIの作業ディレクトリの`var/artifacts` | ファイルシステムの保存先の場所。相対パスはAPIの作業ディレクトリから数えるので、本番では絶対パスにする |
| `S3_BUCKET` | なし | 設定すると、環境変数のS3を保存先として選べる |
| `S3_ENDPOINT` | なし（AWS S3） | S3互換ストレージのendpoint |
| `S3_REGION` | `us-east-1` | region |
| `S3_PREFIX` | なし（bucketの直下） | bucketの中のprefix。`.env.example`では`mado-model-tracking` |
| `S3_FORCE_PATH_STYLE` | `false` | path-styleのURLを使う |
| `S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` | なし | S3の認証情報。無ければAWS SDKの標準の方法で探す |
| `MMT_STORAGE_SECRET_KEY` | なし | 画面で追加したS3の保存先のシークレットをDBで暗号化する鍵（base64の32 byte） |
| `MMT_ARTIFACT_MAX_BYTES` | `214748364800`（200GiB） | Artifact 1件の上限 |
| `MMT_ARTIFACT_DELETE_GRACE_DAYS` | `7` | 削除したArtifactの本体を消すまでの日数。0〜3650 |
| `MMT_UPLOAD_REQUEST_TIMEOUT_MS` | `0`（無効） | uploadの要求全体の締め切り |
| `MMT_UPLOAD_IDLE_TIMEOUT_MS` | `120000` | 通信が止まったuploadを切るまでの時間 |
| `MMT_MLFLOW_MULTIPART_UPLOADS` | `true` | MLflow SDKのmultipart uploadを受け付ける |
| `MMT_MLFLOW_MULTIPART_DOWNLOADS` | `false` | 変えないでください。`true`にするとMLflow 3.17以降のSDKのdownloadが失敗する |
| `MMT_UPLOAD_FINALIZE_WAIT_MS` | `100000` | MLflowのmultipart uploadの完了を待つ時間 |

## 通知

詳しくは[通知と運用アラート](/admin/notifications)を参照してください。

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `MMT_NOTIFICATION_*` | なし | WebhookのURLと署名の鍵。名前は自由に付け、通知先にはその名前を登録する |
| `MMT_SMTP_URL` | なし | SMTPサーバーのURL。`smtp://`（STARTTLS）か`smtps://` |
| `MMT_SMTP_FROM` | なし | 送信元のアドレス。例: `mado ML Tracking <mmt@example.com>` |
| `NODE_EXTRA_CA_CERTS` | なし | 社内CAの証明書（PEM）のパス。SMTPやWebhookの送信先の検証に使う |

## そのほかのAPI serverの設定

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `MMT_CHECKPOINT_KEEP_COUNT` | `5` | Runごとに一覧へ出すcheckpointの数 |
| `MMT_CSV_EXPORT_MAX_ROWS` | `50000` | Run検索のCSV出力の最大行数 |
| `MMT_REPORT_SNAPSHOT_MAX_BYTES` | `52428800` | 共有レポートの1つのバージョンで固定するデータの上限（バイト） |
| `MMT_GIT_SSH_KEY_PATH`、`MMT_GIT_KNOWN_HOSTS_PATH` | なし | エディタへSSHのGitリポジトリを読み込むための秘密鍵とknown_hosts（絶対パス）。両方を設定する |
| `MMT_MADO_PLUGIN_TOKEN` | なし | Mado pluginへ接続するシークレットの例。変数名はPluginの登録で指定する（[PluginとMado連携](/admin/plugins)） |

## preview worker

長い音声・動画のプレビューを作るworker（`npm run preview-worker -w @mmt/api`、またはcomposeの`preview`）の設定です。DBと保存先の設定はAPI serverと同じ値を使います。

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `MMT_PREVIEW_FFMPEG_PATH` | `ffmpeg` | ffmpegのパス |
| `MMT_PREVIEW_FFPROBE_PATH` | `ffprobe` | ffprobeのパス |
| `MMT_PREVIEW_POLL_INTERVAL_MS` | `5000` | 処理するArtifactを探す間隔 |
| `MMT_PREVIEW_TOOL_TIMEOUT_MS` | `1800000`（30分） | ffmpeg・ffprobeの1回の上限。最大40分 |
| `MMT_PREVIEW_WORK_DIR` | OSの一時ディレクトリ | 本体を一時的に置く場所。最大のArtifactが入る空きが要る |

## worker

`mado-tracking-worker`の設定です。`install`で導入した場合は、`~/.config/mado-tracking-worker/<worker-id>.env`にまとめて書かれます。

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `MMT_API_URL` | なし（必須） | API serverのURL。Compute targetからも届くURLにする |
| `MMT_API_TOKEN` | なし（必須） | Service Accountのtoken |
| `MMT_API_TOKEN_FILE` | なし | tokenを読むファイル（コンテナ用）。`MMT_API_TOKEN`があればそちらを使う |
| `MMT_WORKER_ID` | なし（必須） | workerのID。再起動をまたいで同じ値にする |
| `MMT_WORKER_TARGET_IDS` | なし（許可されたすべて） | 担当するCompute targetのID（カンマ区切り） |
| `MMT_WORKER_STATE_DIR` | `~/.local/state/mado-tracking-worker/<IDのハッシュ>` | 実行中のJobの記録を置くディレクトリ |
| `MMT_WORKER_MAX_OUTPUT_FILES` | `10000` | 1つのJobで回収する出力ファイルの上限。1〜1000000 |
| `MMT_ALLOW_LOCAL_EXECUTOR` | なし | `true`でlocal executorを使う（開発用。API側の許可も要る） |

Docker composeで動かす場合は、`MMT_WORKER_TOKEN_FILE`、`MMT_WORKER_SSH_DIR`、`MMT_WORKER_UID`、`MMT_WORKER_GID`、`MMT_WORKER_API_URL`も使います（[worker](/compute/worker)）。

## Python SDK

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `MMT_API_URL` | なし | API serverのURL |
| `MMT_API_TOKEN` | なし | API token |
| `MMT_OFFLINE_DIR` | `~/.local/share/mado-tracking/offline` | オフライン記録を置くディレクトリ |

## 実行コードに渡される変数

workerはJobの実行コードに次の変数を渡します。実行コードはこれを読むだけで、自分で設定する必要はありません。

| 変数 | 内容 |
| --- | --- |
| `MMT_API_URL`、`MMT_API_TOKEN`、`MLFLOW_TRACKING_TOKEN` | 接続先とJob限定token |
| `MMT_PROJECT_ID`、`MMT_EXPERIMENT_ID`、`MMT_RUN_ID`、`MMT_JOB_ID`、`MMT_JOB_KIND` | 実行するRunのIDと種類 |
| `MMT_JOB_CONTEXT_FILE` | Job、Run、パラメータ、モデルバージョン、入力データセットなどをまとめたJSON |
| `MMT_PARAMETERS_FILE`、`MMT_PARAMETERS_JSON` | パラメータ |
| `MMT_MODEL_VERSION_FILE`、`MMT_MODEL_VERSION_ID` | 使うモデルバージョン |
| `MMT_DATASET_VERSIONS_FILE`、`MMT_INPUT_DATASET_VERSION_IDS`、`MMT_INPUT_DATASET_DIRS` | 入力データセットのバージョンと、本体を置いたディレクトリ |
| `MMT_UPSTREAM_RUN_ID`、`MMT_UPSTREAM_RUN_FILE` | 上流のRun（あるときだけ） |
| `MMT_RESUME_CHECKPOINT_DIR`、`MMT_RESUME_STEP`、`MMT_RESUME_CHECKPOINT_FILE` | 再開元のcheckpoint（再開するときだけ） |
| `MMT_OUTPUTS_DIR`、`MMT_RESULT_FILE` | 出力のディレクトリと`result.json`のパス |

## Mado plugin

Mado pluginは別のサービスで、自分の`.env`を持ちます。一覧は[PluginとMado連携](/admin/plugins)の「Pluginの`.env`」を参照してください。
