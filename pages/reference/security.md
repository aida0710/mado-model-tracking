---
title: セキュリティ
description: mado ML Trackingが守るもの、認証情報とシークレットの置き場所、運用する人が行う対策。
---

# セキュリティ

## 認証とsession

- ブラウザのsessionは、HttpOnly・SameSite=Laxのcookieです。`MMT_PUBLIC_URL`がHTTPSならSecureも付けます。期限は、操作しないまま8時間か、ログインから12時間の早い方です（[認証方式とローカルアカウント](/admin/auth)）。
- cookieでの変更の操作は、Originを検証します。許可するのは`MMT_WEB_ORIGIN`と`MMT_PUBLIC_URL`の完全一致だけです。`MMT_ALLOW_PRIVATE_ORIGINS=true`のときは、private IP・loopback・link-local・CGNAT・IPv6 ULAとlocalhostも許可します。Originが無い要求や許可していないOriginは403 `invalid_origin`です。
- ローカルアカウントのパスワードはArgon2idでハッシュ化して保存します。ログインの試行回数には上限があります。
- SSOは、state、nonce、PKCE、ID tokenの署名・issuer・audienceを検証します。callbackは、ログインを始めたブラウザからだけ受け付けます。
- SSOのsessionは60秒ごとにAuthentikでgroupを確かめ直し、groupから外れた人を止めます。Authentikにつながらないときは、確かめられない権限では操作させません（503 `oidc_unavailable`）。
- 本番（`NODE_ENV=production`）では、HTTPSのURLが必須です。開発用ログイン、見本データ、local executor、HTTPのIssuerは使えません。

## API token

- tokenの値はDBに保存しません。SHA-256のハッシュと、見分けるための先頭12文字だけを保存します。値は発行時に1回だけ表示します。
- すべてのtokenに期限があります（上限365日）。scopeと、所有者の現在のProjectのRoleを、要求のたびに確かめます。
- SSOのユーザーのtokenは、ブラウザでのログインから7日を過ぎると止まります。groupから外したことを確かめるためです。
- 実行コードには、worker自身のtokenではなく、そのJobの間だけ使えるJob限定tokenを渡します。書き込めるのは対象のRunとその出力だけです（[API tokenとService Account](/admin/tokens)）。
- MLflow互換APIのBasic認証は、passwordにAPI tokenを入れる形だけを受け付けます。ローカルアカウントのパスワードは受け付けません。

## シークレットの置き場所

| シークレット | 置き場所 | DBと画面 |
| --- | --- | --- |
| DBの接続URL、SSOのClient Secret、SMTPのURL | API serverの`.env` | 保存も表示もしない |
| 通知のWebhookのURLと署名の鍵 | API serverの`.env`（`MMT_NOTIFICATION_*`） | 変数名だけを保存する |
| Pluginへ接続するtoken | API serverの`.env` | 変数名だけを保存する |
| 画面で追加したS3の保存先のシークレット | DB（`MMT_STORAGE_SECRET_KEY`で暗号化） | 画面へは返さない |
| sessionのAuthentikのtoken | DB（`MMT_SESSION_ENCRYPTION_KEY`で暗号化） | 画面へは返さない |
| workerのtoken | workerのホストの環境変数のファイル（mode 600） | ハッシュだけ |
| SSHの秘密鍵とknown_hosts | workerのホスト | パスだけを登録する |

`MMT_STORAGE_SECRET_KEY`を変えると、保存済みのS3のシークレットを復号できなくなり、その保存先のArtifactは503になります。鍵を変えたら、各S3の保存先のシークレットを入れ直してください。`MMT_SESSION_ENCRYPTION_KEY`を変えると、SSOの利用者は次の再確認でログインし直しになります。

API serverはworkerのホストへSSHで接続しません。workerの導入と更新は、workerのホストでCLIを使います。

## 監査ログ

ログイン、権限、token、ユーザー、保存先、通知先などの操作を、無期限に記録します。削除や書き換えはできません。パスワード、token、シークレットの値は記録しません（[監査ログ](/admin/audit)）。

## Artifactとコードの実行

- Artifactは、サーバーが作ったIDを保存のキーにします。利用者のファイル名は表示用の情報としてだけ扱います。
- HTML、SVG、XML、JavaScriptなどのArtifactは、ブラウザで開かずダウンロードとして返します。
- PluginのUI部品や任意のJavaScriptは、ブラウザで実行しません。
- workerは、SSHの接続先のホスト鍵を必ず検証します（`StrictHostKeyChecking=yes`）。未知のホスト鍵や変わったホスト鍵は受け入れません。
- 実行コードに渡す環境変数は、CodeVersionの設定とSDKの接続情報だけです。workerの無関係なシークレットは渡しません。

## 保護されないもの

- 登録したコードは、Compute targetの上で、そのホストのアカウントの権限で動きます。EditorはJobを実行できるので、Compute targetを共有するProjectのEditorには、そのホストでコードを動かす権限を与えることになります。
- GPUの予約は、このアプリのJobの間だけ排他です。ほかのSSHのシェルや別のスケジューラが同じGPUを使うことは防げません。
- ProjectのViewerは、そのProjectのRun、モデル、データセット、Artifactをすべて読めます。Projectより細かい読み取りの制限はありません。

## 運用する人が行う対策

- 本番はHTTPSで公開し、APIとDBのポートを外部に公開しないでください。同梱の`compose.yml`は、Webのポートだけを公開します。
- `.env`は`chmod 600`にし、リポジトリ、チケット、チャットに値を貼らないでください。
- DBとArtifactの保存先は、同じ時点でバックアップしてください。DBだけを戻しても、重みや音声は戻りません。
- worker、自動実行、CIには、人のtokenではなくService Accountのtokenを使い、期限が近づいたら差し替えてください。
- 退職・異動のときは、ユーザーを無効化し、Authentikのgroupからも外してください。
- 共有のGPUマシンでは、このアプリ専用のGPUと作業ディレクトリをCompute targetに設定してください。
