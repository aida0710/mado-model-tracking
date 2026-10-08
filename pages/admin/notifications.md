---
title: 通知と運用アラート
description: Runの失敗や自動実行の失敗、workerの停止などをSlack・Webhook・メールへ通知する設定と、運用アラートの見方。
---

# 通知と運用アラート

Runの失敗、自動実行の失敗、Jobのheartbeatの途絶、workerの停止、Pluginへの送信の滞留を、Slack、Webhook、メールへ通知します。

役割は2つに分かれます。

| 設定 | 担当 | 場所 |
| --- | --- | --- |
| 通知先（どこへ送るか） | 全体管理者 | Projectの［Settings］の「通知」→「通知先」 |
| 通知ルール（どのイベントをどの通知先へ送るか） | ProjectのAdmin | Projectの［Settings］の「通知」→「通知ルール」 |

![Projectの［Settings］の「通知」](/images/admin-notifications.png)

## 通知できるイベント

| イベント | 送るタイミング |
| --- | --- |
| Runの失敗 | Runが失敗で終わった |
| Runの中止 | Runが中止で終わった |
| Runの完了 | Runが完了した（ルールで選んだときだけ） |
| 自動実行の失敗 | モデル登録後の自動実行が起動に失敗した |
| Jobのheartbeat途絶 | 実行中のJobのheartbeatが60秒より古くなった |
| Jobのheartbeat復旧 | 途絶したJobのheartbeatが戻った |
| workerの停止 | workerの最後の応答が120秒より古くなった |
| Plugin送信の滞留 | Pluginへの未送信のイベントが15分以上残っている、または同じイベントの送信に5回以上失敗した |

## 1. URLとシークレットを環境変数に置く

WebhookのURLと署名の鍵は、DBにも画面にも保存しません。API serverの環境変数に値を置き、通知先には変数名だけを登録します。変数名は`MMT_NOTIFICATION_`で始まる英大文字・数字・`_`だけです。

```sh
# API serverの.env。値はリポジトリやチャットに貼らない
MMT_NOTIFICATION_SLACK_URL=https://hooks.slack.com/services/...
MMT_NOTIFICATION_OPS_URL=https://ops.example.com/hooks/mmt
MMT_NOTIFICATION_OPS_SECRET=<下のコマンドで作った値>
```

Webhookの署名の鍵は、ターミナルで作ります。

```sh
openssl rand -hex 32
```

環境変数を変えたら、APIを再起動します。

### メールを送る場合

メールは、API serverに次の2つがあるときだけ送ります。

```sh
# STARTTLSなら smtp://...:587、最初からTLSなら smtps://...:465
MMT_SMTP_URL=smtps://<user>:<password>@smtp.example.com:465
MMT_SMTP_FROM=Mado Model Tracking <mmt@example.com>
```

- userとpasswordに記号を含むときは、URLエンコードします。URLの`?`以降は受け付けません。
- 片方だけの設定や形式の違う値は、APIの起動を止めます。エラーには変数名だけを表示します。
- TLSの証明書は常に検証します。社内CAの証明書を使うSMTPサーバーなら、API serverの`NODE_EXTRA_CA_CERTS`にCAのPEMファイルのパスを指定します。

## 2. 通知先を追加する（全体管理者）

1. Projectの［Settings］を開き、「通知」の「通知先」で［通知先を追加］を押します。
2. 種類ごとに次の値を入力して保存します。

| 種類 | 入力する項目 | 入力値の例 |
| --- | --- | --- |
| Slack（Incoming Webhook） | URLを参照する環境変数名 | `MMT_NOTIFICATION_SLACK_URL` |
| Webhook（署名付き） | URLを参照する環境変数名、署名の鍵を参照する環境変数名 | `MMT_NOTIFICATION_OPS_URL`、`MMT_NOTIFICATION_OPS_SECRET` |
| メール | 宛先のメールアドレス（1行に1件、50件まで） | `ml-team@example.com` |

［使えるProject］で「すべてのProject」を選ぶと、ほかのProjectのルールからも使えます。「このProjectだけ」は、このProjectのルールだけが使います。

3. 一覧の［送信設定］が「設定済み」になっていることを確かめます。「未設定」なら、APIのプロセスにその環境変数が見えていません（メールでは「未設定（SMTPの送信設定が無い）」）。
4. ［テスト送信］を押し、「テスト送信が届きました」と表示されることと、送信先に届いたことを確かめます。

テスト送信は送信履歴には残りません。結果は監査ログの「通知先のテスト送信」に残ります。

## 3. 通知ルールを作る（ProjectのAdmin）

1. 「通知ルール」で［通知ルールを作成］を押します。
2. 次の値を選んで保存します。

| 項目 | 選ぶもの |
| --- | --- |
| 通知先 | 上で登録した通知先 |
| 通知するイベント | 1つ以上。例: 「Runの失敗」「自動実行の失敗」「workerの停止」 |
| Runの実行種別 | 学習、推論、評価など。選ばなければすべて |
| 実験 | 選ばなければすべて |
| 自動実行が起動したRunだけ | 自動実行のRunだけを通知するときに選ぶ |

作成したルールの条件は変えられません。変えるときは新しいルールを作り、古いルールを［無効にする］で止めます。

Runの実行種別や実験の条件を付けたルールには、workerの停止とPlugin送信の滞留は届きません。これらのイベントはRunを持たないためです。運用の通知は、条件の無いルールで受け取ってください。

## 届く内容

| 種類 | 内容 |
| --- | --- |
| Slack | タイトル、Project、Run、実験、種別・状態、エラーの先頭500文字 |
| Webhook | イベントのJSON。ヘッダーに`X-MMT-Event`、`X-MMT-Event-Id`、`X-MMT-Delivery`、`X-MMT-Signature: sha256=<HMAC-SHA256(鍵, 本文)>` |
| メール | 件名`[<Project名>] <タイトル>`、本文はSlackと同じ項目のテキスト（エラーは先頭2000文字） |

Webhookの受信側では、`X-MMT-Signature`を本文のバイト列そのままで検証し、`X-MMT-Event-Id`で重複を除いてください。同じイベントは、どのルールから送っても同じIDです。

どの通知にも、実行時の設定、パラメータ、環境変数、tokenは入りません。

## 送信の流れと失敗したとき

- Runが終わったとき、条件に合う有効なルールごとに1件ずつ送信待ちに積みます。同じRunの同じイベントは1回だけです。
- APIの中で1秒ごとに取り出して送ります。HTTPの送信は5秒、メールは10秒で打ち切ります。リダイレクトはたどりません。
- 失敗すると、5秒から倍々（上限1時間）に間隔を空けて再送し、8回（約10分）失敗すると「失敗」にします。古い通知を送り続けても意味が薄いためです。
- 送信待ちのあいだに通知先やルールを無効にした通知は、送らずに「失敗」にします。有効に戻しても、古い通知はまとめて届きません。

ProjectのAdminは、「直近の送信履歴」で状態、試行回数、失敗の理由を確認できます。

| 失敗の理由 | 確認すること |
| --- | --- |
| API serverに、通知先が参照する環境変数が設定されていません | `.env`の変数名と値、APIを再起動したか |
| 送信先がHTTP 4xx／5xxを返しました | WebhookのURLが正しいか、受信側の状態 |
| 送信先に接続できませんでした | API serverから送信先への通信、証明書 |
| 送信先の応答が時間内にありませんでした | 受信側が5秒以内に応答するか |
| SMTPサーバーの認証に失敗しました | `MMT_SMTP_URL`のuserとpassword |
| SMTPサーバーとのTLS接続に失敗しました | ポートと`smtp://`／`smtps://`の組み合わせ |

## 運用アラート

API serverは30秒ごとに、Jobのheartbeatの途絶、workerの停止、Pluginへの送信の滞留を確かめます。見つかると、上部バーのベルに「運用アラート」として件数を表示し、ルールで選んだ通知先へ1回だけ通知します。

| 種類 | 開く条件 | 閉じる条件 |
| --- | --- | --- |
| Jobのheartbeat途絶 | 実行中のJobのheartbeatが60秒より古い | heartbeatが戻る（「Jobのheartbeat復旧」を通知）、またはJobが終わる |
| workerの停止 | workerの最後の応答が120秒より古い | workerが再び応答する、tokenが失効・期限切れになる、7日以上応答が無い |
| Plugin送信の滞留 | 最古の未送信が15分より古い、または5回以上失敗した | 未送信が条件を下回る、Pluginを無効にする |

- heartbeatが途絶しても、Jobは失敗にしません。workerがまだ処理を続けている場合があるためです。止まったJobは［Jobs］で停止を要求するか、workerのホストを確かめてください。
- Pluginの送信状況は［Plugins］の「イベントの送信状況」で確認できます。Pluginを直したら［イベントを再送］を押します（[PluginとMado連携](/admin/plugins)）。
- 閾値はコードの定数で、環境変数では変えられません。
