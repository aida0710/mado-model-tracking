---
title: API tokenとService Account
description: 個人のAPI token、人に紐付かないService Account、scope・期限・失効、Jobごとに発行するJob限定token。
---

# API tokenとService Account

SDK、MLflow、worker、CIからAPIを使うときは、API tokenで認証します。tokenには3種類あります。

| 種類 | 所有者 | 発行する場所 | こんなときに向いています |
| --- | --- | --- | --- |
| 個人のAPI token | ログインしたユーザー | ［Settings］の「自分のAPI token」、MLflow 3の接続カード | 自分のPCやノートブックからRunを記録する |
| Service Accountのtoken | Service Account（人に紐付かない） | ［Settings］の「Service Accounts」 | worker、自動実行、CIなど長く動くもの |
| Job限定token | Runの作成者 | workerがJobごとに自動で受け取る | 実行コードの中からRunへ記録する。人が発行することはありません |

tokenの値は発行したときに1回だけ表示されます。DBにはハッシュと先頭12文字だけを保存し、どの一覧にも値は表示しません。

## scope

tokenで使える操作はscopeで決めます。所有者のProjectのRoleが足りないscopeは選べません。

| scope | できること | 所有者に要るRole |
| --- | --- | --- |
| `read` | 読み取り | Viewer |
| `runs:write` | Runの作成と記録 | Editor |
| `registry:write` | モデル・データセットの登録 | Editor |
| `artifacts:write` | Artifactの保存 | Editor |
| `jobs:write` | Jobの起動と取り消し | Editor |
| `worker:execute` | workerとしてJobを実行 | Admin |
| `admin` | Projectの管理。ほかのscopeの操作もすべて含みます | Admin |

tokenで操作するときは、scopeに加えて、所有者の現在の実効Roleも毎回確かめます。所有者をProjectから外したり、Roleを下げたりすると、tokenを失効させなくても、その操作は403になります。

## 期限

新しいtokenはすべて期限を持ちます。画面では7日、30日、90日（既定）、365日から選びます。期限の上限はAPI serverの`MMT_TOKEN_MAX_LIFETIME_DAYS`（既定365日）で、APIで期限を省略するとこの上限の日時になります。上限を超える期限は422 `token_lifetime_exceeded`です。

期限が切れたtokenは401になります。期限が近づいたら新しいtokenを発行して差し替えてください。

## 個人のAPI tokenを発行する

1. Projectの［Settings］を開き、「自分のAPI token」の［API tokenを発行］を押します。
2. 名前、scope、有効期限を選んで［保存］を押します。

| 項目 | 入力値の例 |
| --- | --- |
| 名前 | `laptop-notebook`（どこで使うか分かる名前） |
| Scope | Runを記録するなら`read`と`runs:write`、Artifactも保存するなら`artifacts:write` |
| 有効期限 | `90日` |

3. 表示されたtokenを［コピー］して、安全な場所に保存します。閉じると二度と表示されません。

画面から発行したtokenは、そのProjectに限定されます。MLflow 3から使う場合は、［Settings］の「MLflow 3から接続」の［このProject用のAPI tokenを発行］からも発行できます。発行後に、環境変数の設定例が表示されます。

ターミナルでは、tokenをコマンドの引数やファイルに書かず、入力して環境変数に入れます。

```sh
export MMT_API_URL=https://tracking.example.com
read -rsp 'API token: ' MMT_API_TOKEN
export MMT_API_TOKEN
```

tokenが使えることは、次のコマンドで確かめられます。tokenのscopeと限定したProjectが表示されます。

```sh
curl -sS -H "Authorization: Bearer $MMT_API_TOKEN" "$MMT_API_URL/api/auth/token"
```

### SSOのユーザーのtokenは7日で止まる

SSOでログインするユーザーのtokenは、最後にブラウザでログインしてから7日（`OIDC_TOKEN_SYNC_MAX_AGE_SECONDS`）を過ぎると、401 `identity_sync_required`で止まります。Authentikでgroupから外したことを確かめるためです。ブラウザで一度ログインすれば、同じtokenがまた使えます（[Authentik（SSO）](/admin/sso)）。

## Service Account

Service Accountは、人に紐付かない、1つのProjectに属するアカウントです。発行した人がProjectを離れても、Service Accountのtokenは止まりません。SSOのtokenの7日の期限も適用されません。

![Projectの「Service Accounts」と「Projectのtoken一覧」](/images/admin-service-accounts.png)

### Service Accountを作る

ProjectのAdminがブラウザで操作します（API tokenからは作れません）。

1. ［Settings］の「Service Accounts」で［Service Accountを作成］を押します。
2. 次の値を入力して保存します。

| 項目 | 入力値の例 |
| --- | --- |
| 名前 | `gpu-host-1-worker`（Project内で一意、200文字まで） |
| 説明 | `GPUサーバー1台目のworker` |
| Role | workerなら`Admin`、自動実行の所有者なら`Admin`、読み取りだけのCIなら`Viewer` |

3. 作成した行の［API tokenを発行］を押し、名前、scope、有効期限を選んで保存します。表示されたtokenを控えます。

![Service Accountのtoken発行](/images/admin-token-dialog.png)

選べるscopeは、Service AccountのRoleまでです。`worker:execute`はRoleがAdminのService Accountにだけ発行できます。

用途ごとのscopeの例です。

| 用途 | Role | scope |
| --- | --- | --- |
| worker | Admin | `read`、`worker:execute`、`artifacts:write`。出力のモデル・データセットを登録するなら`registry:write`も |
| 自動実行ルール・昇格policyの所有者 | Admin | tokenは不要（所有者として移管するだけ） |
| CIからRunを記録 | Editor | `read`、`runs:write`、`artifacts:write` |

workerの導入手順は[worker](/compute/worker)、自動実行ルールの所有者をService Accountへ移す手順は[自動実行](/models/automation)を参照してください。

### 止める・変える

- 一時的に止める: 行の［無効化］を押します。そのService Accountのtokenはすべて、次の要求から401になります。［有効化］で戻すと、同じtokenがまた使えます。
- Roleを変える: ［変更］でRoleを選び直します。Roleを下げると、新しいRoleを超えるscopeの操作は403になります。
- 1本だけ止める: 下の「Projectのtoken一覧」で失効させます。

Service Accountは全体の［ユーザー］タブにも「Service Account」として表示されますが、ログインはできず、全体管理者にもできません。

## tokenを失効させる

- 自分のtoken: ［Settings］の「自分のAPI token」、または［アカウント］の「自分のAPI token」で［失効］を押します。
- Projectのtoken: ProjectのAdminは「Projectのtoken一覧」で、そのProjectに限定された全員とService Accountのtokenを確認し、［失効］で止められます。一覧には所有者、先頭12文字、scope、有効期限、最終使用（5分ごとに更新）が表示されます。

失効させたtokenは次の要求から401になり、元に戻せません。発行と失効は監査ログに「API tokenの発行」（`token.create`）、「API tokenの失効」（`token.revoke`）として残ります。

### 旧形式のtoken

一覧で「旧形式」と表示されるtokenは、個人が所有するservice tokenです。所有者がProjectを離れると止まるので、Service Accountのtokenへ置き換えてください。稼働中のPlaygroundの旧形式tokenは、期限（2026-10-15）までに置き換えます。

## Job限定token

workerはJobを実行するたびに、そのJobだけで使えるtoken（`mmtj_`で始まる）をAPIから受け取り、実行コードの`MMT_API_TOKEN`と`MLFLOW_TRACKING_TOKEN`に渡します。worker自身のtokenは実行コードに渡しません。人がJob限定tokenを発行・管理することはありません。

- 権限はRunの作成者の現在の実効Roleで決まります。scopeは`read`、`runs:write`、`artifacts:write`、`registry:write`です。
- 書き込めるのは、対象のRun（metrics、params、tags、ログ、入力Dataset、Artifact）、そのRunを生成元とするモデル・データセットの版、そのRunのLogged Model、出力先のModelの作成だけです。同じProjectの別のRun、token発行、Projectの設定、自動実行ルールへの書き込みは403 `job_token_forbidden`になります。
- 読み取りは同じProjectの中ならできます。上流RunのArtifactを取得するときに使います。
- Jobが終わる（完了・失敗・中止）と、tokenは401になります。

実行コードからの使い方は[worker](/compute/worker)を参照してください。

## MLflowのBasic認証

ユーザー名とパスワードしか設定できないツールのために、MLflow互換API（`/api/mlflow/...`）だけはBasic認証も受け付けます。passwordにAPI tokenを入れ、ユーザー名は空でも構いません。ローカルアカウントのパスワードは受け付けません。

```sh
export MLFLOW_TRACKING_USERNAME=token
read -rsp 'API token: ' MLFLOW_TRACKING_PASSWORD
export MLFLOW_TRACKING_PASSWORD
```

独自APIへのBasic認証は401 `basic_auth_unsupported`です。MLflowの接続手順は[MLflow 3から記録する](/tracking/mlflow)を参照してください。
