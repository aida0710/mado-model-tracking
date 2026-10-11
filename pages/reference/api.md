---
title: 独自API
description: mado ML Trackingの独自API（native API）の認証、共通の形、エラー、機能ごとの分類と、OpenAPI（openapi.json）の取得方法。
---

# 独自API

mado ML TrackingのAPIは2つあります。

| API | 接続先 | こんなときに向いています |
| --- | --- | --- |
| MLflow 3互換API | `/api/mlflow/projects/<Project ID>` | 公式のMLflow 3 SDKや、MLflowに対応したツールから記録する（[MLflow 3から記録する](/tracking/mlflow)） |
| 独自API（native API） | `/api` | Python SDK（`mado-tracking`）、worker、画面、MLflowに無い機能（Job、自動実行、昇格policy、監査ログなど）を使う |

このページでは独自APIを説明します。Pythonから使う場合は、APIを直接呼ぶより[Python SDK](/tracking/sdk)が便利です。

## 認証

| 方法 | 使う場面 |
| --- | --- |
| `Authorization: Bearer <API token>` | SDK、スクリプト、CI、worker |
| session cookie | ブラウザ（画面）。変更の操作ではOriginを検証します |

API tokenの発行とscopeは[API tokenとService Account](/admin/tokens)を参照してください。tokenでの操作は、scopeとtokenの所有者のProjectのRoleを両方確かめます。

```sh
export MMT_API_URL=https://tracking.example.com
read -rsp 'API token: ' MMT_API_TOKEN
export MMT_API_TOKEN

curl -sS -H "Authorization: Bearer $MMT_API_TOKEN" "$MMT_API_URL/api/projects"
```

一部の操作はブラウザのsessionでだけ使えます。API tokenで呼ぶと403 `session_required`になります。

- API tokenの発行と失効
- Service Accountの作成・変更・token発行
- 全体の監査ログ、ユーザーの管理（「全体管理」）

## 共通の形

- JSONのキーはcamelCaseです。
- IDはUUID、日時はISO 8601（UTC）です。
- 1件の取得・作成は、そのものを直接返します。一覧は`{items: [...]}`の形です。続きがある一覧は`nextCursor`を返すので、次の要求の`cursor`に渡します。
- JSONの本文は既定で4MiBまでです。例外（オフライン記録の後送りは32MiB、DatasetVersionの作成は128MiB）はOpenAPIに書いています。
- Artifactの本体の取得はHTTPのRangeに対応しています。

## エラー

エラーは次の形で返します。`error`は人が読むための文、`code`はプログラムで判定するための値です。判定には`code`を使ってください。

```json
{"error": "API tokenのscopeが不足しています", "code": "insufficient_scope"}
```

| status | よくある`code` | 意味 |
| --- | --- | --- |
| 400 | `invalid_cursor`、`invalid_parameter_value` | 検索条件やcursorが正しくない |
| 401 | `authentication_required`、`invalid_token` | ログインしていない、tokenが無効・失効・期限切れ |
| 401 | `identity_sync_required` | SSOのユーザーが7日以上ブラウザでログインしていない（[Authentik（SSO）](/admin/sso)） |
| 403 | `insufficient_scope` | tokenのscopeが足りない |
| 403 | `project_forbidden` | ProjectのRoleが足りない、またはtokenを限定したProjectと違う |
| 403 | `session_required` | ブラウザのsessionでだけ使える操作 |
| 403 | `job_token_forbidden` | Job限定tokenで許されていない操作 |
| 403 | `password_change_required` | 初回ログインのパスワード変更が済んでいない |
| 404 | — | 対象が無い、または別のProjectのもの |
| 409 | `conflict`ほか | 状態の競合（最後のAdminを外す、終わったJobへの操作、Jobが動いているProjectのアーカイブ（`project_has_active_jobs`）、アーカイブしていないProjectの削除（`project_not_archived`）など） |
| 413 | `artifact_too_large` | Artifactが上限（既定200GiB）を超えた |
| 422 | `invalid_request`ほか | 入力の形式や値が正しくない |
| 429 | `rate_limited` | ログインの試行回数の上限。`Retry-After`秒待つ |
| 503 | `oidc_unavailable` | AuthentikにつながらずSSOのsessionを確かめられない |
| 503 | `database_unavailable` | DBにつながらない（`GET /api/health`） |

## 機能ごとの分類

OpenAPIでは、APIを次の分類（tag）に分けています。

| 分類 | 内容 |
| --- | --- |
| `system` | 稼働確認（`GET /api/health`）とOpenAPI |
| `auth` | ログイン、session、自分のアカウント |
| `access` | Projectのメンバー、groupへの付与 |
| `tokens` | API token、Service Account |
| `projects` | Project、Experiment |
| `runs` | Runの記録・検索・比較・再開 |
| `analysis` | メトリクスの系列、探索結果の分析 |
| `media` | Runのstepごとの音声・画像・動画・表 |
| `collaboration` | Runの説明文、コメント |
| `saved-views`、`reports` | 保存ビュー、共有レポート |
| `sync` | オフライン記録の後送り |
| `checkpoints` | 学習の途中再開 |
| `sweeps` | ハイパーパラメータの探索 |
| `registry` | Model、Code、Datasetとそのバージョン |
| `automation` | モデル登録後の自動実行と連鎖 |
| `evaluation`、`promotion` | 評価結果の比較、昇格policyと判定 |
| `tasks` | Taskと起動 |
| `artifacts`、`artifact-uploads` | Artifactの保存・一覧・取得、再開可能なupload |
| `execution` | Job、Compute target、worker |
| `worker` | workerだけが使うAPI（`worker:execute`のtoken） |
| `plugins` | Pluginの接続 |
| `notifications`、`operations` | 通知、運用アラート |
| `audit` | 監査ログ |
| `admin` | 全体管理（プロジェクト、保存先とディレクトリ候補、ユーザー） |

## OpenAPI（openapi.json）

すべてのrouteの認可、入力、出力、エラーコードを、OpenAPI 3.1の形式で公開しています。MLflow互換APIは含みません（MLflow公式のREST APIに従います）。

- 動いているサーバーから: ログインしたブラウザか、`read` scopeのtokenで`GET /api/openapi.json`を取得します。
- リポジトリから: [docs/openapi.json](https://github.com/aida0710/mado-ml-tracking/blob/main/docs/openapi.json)

```sh
curl -sS -H "Authorization: Bearer $MMT_API_TOKEN" "$MMT_API_URL/api/openapi.json" -o openapi.json
```

取得したファイルは、Swagger UIやRedoc、OpenAPIのクライアント生成ツールで読み込めます。

OpenAPIには、このアプリ独自の項目があります。

| 項目 | 内容 |
| --- | --- |
| `security` | `sessionCookie`か`bearerToken`。`bearerToken`の値は必要なscope |
| `x-mmt-access` | 必要なProjectのRoleとscope、ブラウザのsessionだけで使えるか |
| `x-mmt-job-token` | Job限定tokenで呼べるか（`read`、`write`、`forbidden`。`write`はtokenのRunへの書き込みだけ） |
| `x-mmt-error-codes` | statusごとのエラーコード |
| `x-mmt-max-body-bytes` | 本文の上限が既定と違うrouteの上限 |

振る舞いの正本はリポジトリの`docs/api-contract.md`で、`openapi.json`はそれを機械で読める形にしたものです。両者の食い違いはテストで検出しています。
