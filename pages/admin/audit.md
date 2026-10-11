---
title: 監査ログ
description: ログイン、権限、token、ユーザー、保存先、通知などの操作の記録と、その読み方・APIでの取得方法。
---

# 監査ログ

誰が、いつ、何をしたかを記録します。ログイン、権限の変更、Projectの作成・アーカイブ・削除、API tokenの発行と失効、ユーザーの管理、保存先と通知先の変更、Artifactの削除などが対象です。

監査ログは無期限に保存し、削除や変更はできません。画面にもAPIにも削除の機能は無く、DBでも書き換えを拒否します。

## 見る場所

| 場所 | 見られる人 | 範囲 |
| --- | --- | --- |
| ［プロジェクト設定］の「監査ログ」 | ProjectのAdmin | そのProjectの記録 |
| 「全体管理」→［監査ログ］ | 全体管理者 | すべてのProjectと、Projectに属さない記録（ログイン、ユーザーの管理、保存先、通知先など）。完全に削除したProjectの記録もここで読めます |

![Projectの監査ログ](/images/admin-audit.png)

新しい順に表示します。古い記録は一覧の下の［さらに読む］で読み込みます。

| 列 | 内容 |
| --- | --- |
| 日時 | 記録した時刻 |
| 操作者 | 操作したユーザーの表示名。API tokenでの操作は「田中 (API token)」のようにtokenの所有者の名前に続けて表示します。ログインの失敗やSSOのログインの拒否など、ユーザーが操作していないものは「システム」 |
| 操作 | 操作の種類。「API tokenの発行」など |
| 結果 | 「成功」「拒否」「失敗」 |
| 対象 | 操作の対象（`api_token/<ID>`など） |
| 詳細 | 操作ごとの情報（変更前後のRole、scope、拒否の理由のコードなど） |

## 記録するもの・しないもの

- 成功した操作は、その操作と同じtransactionで記録します。操作が取り消された（rollbackした）場合は、記録も残りません。
- 権限不足（403）と競合（409）で断った操作は、「拒否」として`details.code`（APIのエラーコード）つきで残します。
- 入力の誤りや、存在しない対象への操作は記録しません。ログインの回数制限で断った試行も記録しません。
- パスワード、tokenの値とハッシュ、シークレット、通知先のメールアドレスは記録しません。
- 接続元のIPアドレスとUser-Agentを残します。IPアドレスはAPIが受けた接続の相手です。前段のproxyを通す構成では、proxyのアドレスになります（`X-Forwarded-For`などのヘッダーは信用しません）。

## 主な操作

| 操作（画面の表示） | 操作名 | 主な詳細 |
| --- | --- | --- |
| ログイン | `auth.login` | `method`（`local`、`oidc`、`development`）。失敗は結果が「失敗」 |
| ログアウト | `auth.logout` | |
| パスワードの変更 | `auth.password.change` | |
| 初期管理者の作成・再設定 | `auth.bootstrap_admin` | |
| SSOのgroupと権限の同期 | `auth.oidc.sync` | `created`、`globalRoleBefore`／`After`、`groupsAdded`／`Removed` |
| SSOログインの拒否 | `auth.oidc.denied` | `reason`、`subject`、`email` |
| SSO sessionの再確認による失効 | `auth.oidc.recheck` | `reason`、`scope`（`session`か`identity`）、`revokedSessions` |
| SSOからのログアウト | `auth.oidc.backchannel_logout` | `subject`、`sid`、`revokedSessions` |
| ユーザーの作成・変更・パスワードの再設定 | `admin.user.create`、`admin.user.update`、`admin.user.password_reset` | 変更前後の状態・全体管理者・表示名 |
| Projectの作成・変更（説明、公開範囲、保存先）・アーカイブ・元に戻す・完全に削除 | `project.create`、`project.update`、`project.archive`、`project.restore`、`project.purge` | 名前、公開範囲、保存先、作成時のメンバーの人数、変えた項目 |
| メンバーの権限変更・直接付与の削除 | `project.member.set`、`project.member.delete` | 変更前後のRole。Projectの作成時に追加したメンバーも`project.member.set`で残ります |
| groupへの権限付与・付与の削除 | `project.group_binding.set`、`project.group_binding.delete` | `group`、変更前後のRole |
| API tokenの発行・失効 | `token.create`、`token.revoke` | 名前、種類、scope、期限、所有者の種類 |
| Service Accountの作成・変更 | `service_account.create`、`service_account.update` | 変更前後のRole・状態 |
| 保存先の追加・変更・接続テスト、既定の保存先の変更 | `storage.backend.create`、`storage.backend.update`、`storage.backend.test`、`storage.settings.update` | |
| 通知先の作成・変更・テスト送信 | `notification.channel.create`、`update`、`test` | 名前、種類、環境変数名、宛先の件数 |
| 通知ルールの作成・変更 | `notification.rule.create`、`update` | |
| Artifactの削除 | `artifact.delete`、`artifact.mlflow_delete` | path、サイズ、保存先 |
| 自動実行ルール・昇格policyの所有者の変更 | `automation_rule.owner.transfer`、`promotion_policy.owner.transfer` | |

このほか、実験・モデル・データセットの変更、Runの説明文、コメント、保存ビュー、レポート、Sweep、aliasの保護なども記録します。画面に名前の無い新しい操作は、操作名のまま表示します。

## APIで読む

監査ログはAPIでも読めます。新しい順で、1回に最大200件（既定50件）です。続きは応答の`nextCursor`を`cursor`に渡します。

```sh
# Projectの記録（ProjectのAdmin。API tokenはadmin scope）
curl -sS -H "Authorization: Bearer $MMT_API_TOKEN" \
  "$MMT_API_URL/api/projects/<Project ID>/audit-events?action=token.create&limit=100"
```

| 絞り込み | 例 |
| --- | --- |
| `action` | `auth.oidc.denied` |
| `actorUserId` | 操作したユーザーのID |
| `outcome` | `success`、`denied`、`failed` |
| `projectId`（全体の一覧だけ） | ProjectのID |

全体の記録（`GET /api/audit-events`）は、全体管理者がブラウザでログインしているときだけ読めます。API tokenでは、全体管理者のtokenでも403 `session_required`です。ブラウザで全体管理者としてログインした状態で、次のURLを開きます。

```text
https://tracking.example.com/api/audit-events?action=auth.oidc.denied
```

画面の「全体管理」→［監査ログ］には、今は絞り込みがありません。操作や結果で絞り込むときは、このAPIを使います。
