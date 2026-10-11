---
title: トラブルシューティング
description: APIが起動しない、SSOでログインできない、tokenが401・403になる、通知が届かない、Pluginやworkerが止まったときの確認項目。
---

# トラブルシューティング

## APIが起動しない

APIは、設定に問題があると、足りない設定や形式の違う設定の名前だけを表示して止まります。値は表示しません。

```text
Invalid configuration: OIDC_RECHECK_SECONDS
MMT_SESSION_ENCRYPTION_KEY is required when AUTH_MODE=hybrid
```

| 表示 | 直し方 |
| --- | --- |
| `MMT_DATABASE_URL or DATABASE_URL is required` | `.env`にDBの接続URLを入れる |
| `OIDC_ISSUER_URL and OIDC_CLIENT_ID are required when AUTH_MODE=...` | Authentikの設定を入れるか、`AUTH_MODE=local`にする |
| `MMT_SESSION_ENCRYPTION_KEY is required ...`、`... must be base64 of 32 bytes` | `openssl rand -base64 32`で作った値を入れる |
| `OIDC issuer requires HTTPS ...` | IssuerをHTTPSのURLにする |
| `Production URLs require HTTPS` | `NODE_ENV=production`では`MMT_PUBLIC_URL`と`MMT_WEB_ORIGIN`をHTTPSにする |
| `Development authentication is forbidden in production` | 本番では`AUTH_MODE`を`local`、`oidc`、`hybrid`のどれかにする |
| `AUTH_SESSION_IDLE_SECONDS must not exceed AUTH_SESSION_ABSOLUTE_SECONDS` | idleをabsolute以下にする |
| `MMT_GIT_SSH_KEY_PATH and MMT_GIT_KNOWN_HOSTS_PATH must be set together` | 両方を設定するか、両方を消す |

`OIDC_ALLOWED_GROUPS`が空のとき、`OIDC_ROLE_MAPPING_JSON`に`admin`・`user`以外のroleを書いたとき、`OIDC_ADMIN_GROUP`と対応表のadminのgroupが食い違うときも起動しません。SMTPの設定は、`MMT_SMTP_URL`と`MMT_SMTP_FROM`の片方だけでは起動しません。

更新したあとに起動しない場合は、新しく必須になった設定が無いかを確かめてください。SSOの再確認を含むバージョンからは`MMT_SESSION_ENCRYPTION_KEY`が、groupで許可を決めるバージョンからは`OIDC_ALLOWED_GROUPS`が必須です。

## SSOでログインできない

利用者には理由を区別せずに401を返します。理由は監査ログの「SSOログインの拒否」（`auth.oidc.denied`）の`details.reason`と、APIの標準エラー出力の1行のJSON（`{"event":"oidc_login_denied","reason":...}`）に残ります。全体管理者は、ブラウザでログインした状態で次のURLを開くと確認できます。

```text
https://tracking.example.com/api/audit-events?action=auth.oidc.denied
```

| `reason` | 意味 | 直し方 |
| --- | --- | --- |
| `group_not_allowed` | `OIDC_ALLOWED_GROUPS`のどのgroupにも入っていない | Authentikでgroupに入れる。ID tokenに`groups`が出ているかも確かめる |
| `email_not_verified` | `email`が無いか、`email_verified`がtrueでない | Authentikでメールアドレスを検証済みにし、scope mappingで`email_verified`を出す |
| `user_disabled` | このアプリでユーザーが無効になっている | 全体管理者が「全体管理」→［ユーザー］で有効化する |
| `last_admin` | 同期すると有効な全体管理者が0人になる | 別の全体管理者（ローカルの管理者でもよい）を先に用意する |
| `privileged_link_required` | 同じメールアドレスの特権を持つローカルアカウントがある | 自動では結び付けない。全体管理者がローカルアカウントの権限を確かめて対応する |
| `service_account` | Service Accountとしてログインしようとした | Service Accountはログインできない |

監査ログに`auth.login`の失敗（`details.reason`が`invalid_oidc_state`）がある場合や、標準エラー出力に`oidc_authentication_failed`がある場合は、Authentikとの通信、ログイン画面を開いてから時間がたちすぎた、別のブラウザでcallbackを開いた、などが原因です。もう一度ログインからやり直してください。それでも失敗する場合は、AuthentikのRedirect URIが`<MMT_PUBLIC_URL>/api/auth/callback`と完全に一致しているかを確かめます。

## ログイン中に急にログイン画面に戻る

SSOのsessionの再確認で、sessionが終了した可能性があります。監査ログの「SSO sessionの再確認による失効」（`auth.oidc.recheck`）の`reason`を確かめます。

| `reason` | 意味 | 直し方 |
| --- | --- | --- |
| `group_not_allowed` | 許可されたgroupから外れた | groupの所属を確かめる。UserInfoに`groups`が出ていないと全員がこれになる |
| `idp_session_revoked` | Authentikがtokenを拒否した（Authentikでログアウトした、など） | もう一度ログインする |
| `reauthentication_required` | refresh tokenが無いままaccess tokenが切れた | `OIDC_SCOPES`とProviderに`offline_access`を入れる |

## 「Authentikに接続できない」（503 `oidc_unavailable`）

API serverからAuthentikに接続できないため、SSOのsessionの権限を確かめられない状態です。sessionは残っているので、Authentikが復旧すれば同じsessionで続けられます。API serverからAuthentikのIssuerのURLへ接続できるかを確かめてください。

Authentikが長く止まる場合は、`AUTH_MODE=hybrid`にしてローカルの管理者でログインできます。

Authentikに接続できないあいだは、前回の確認から`OIDC_RECHECK_SECONDS`を過ぎたSSOのsessionでは、ログアウトの操作も503になります。ログアウトできなくても、操作は受け付けられません。Authentikが復旧するか、sessionの期限が切れるのを待ってください。

## 「パスワードを変更」の画面から進めない

初期管理者や、管理者がパスワードを再設定したアカウントは、パスワードを変更するまでほかの画面を使えません（403 `password_change_required`）。12〜1024 byteで、現在と異なるパスワードに変更してください。

管理者のパスワードが分からなくなった場合は、API serverのターミナルで`npm run bootstrap-admin -w @mmt/api`を実行して再設定します。

## 「試行回数の上限に達しました」

ログインの試行回数の上限を超えました（429 `rate_limited`）。応答の`Retry-After`秒のあいだ待ってから、もう一度試してください。上限は[認証方式とローカルアカウント](/admin/auth)の「パスワード」にあります。

## API tokenが401・403になる

| 応答 | 原因 | 直し方 |
| --- | --- | --- |
| 401 `invalid_token` | tokenが無効、失効、期限切れ。所有者のユーザーかService Accountが無効 | 新しいtokenを発行する。Service Accountの状態を確かめる |
| 401 `identity_sync_required` | SSOのユーザーが7日以上ブラウザでログインしていない | ブラウザで一度ログインすれば、同じtokenが使える。長く動く処理はService Accountのtokenにする |
| 403 `insufficient_scope` | tokenのscopeが足りない | 必要なscopeでtokenを発行し直す |
| 403 `project_forbidden` | 所有者のProjectのRoleが足りない、またはtokenを限定したProjectと違う | Roleを確かめる。groupから外れていないかも確かめる |
| 403 `session_required` | ブラウザでだけ使える操作（token発行、Service Account、全体の監査ログなど） | 画面から操作する |
| 403 `job_token_forbidden` | Job限定tokenで許されていない操作 | 実行コードから行える操作か確かめる（[API tokenとService Account](/admin/tokens)） |
| 401 `basic_auth_unsupported` | 独自APIにBasic認証を使った | Bearer tokenにする。Basic認証はMLflow互換APIだけ |

tokenのscopeと限定したProjectは、次のコマンドで確かめられます。

```sh
curl -sS -H "Authorization: Bearer $MMT_API_TOKEN" "$MMT_API_URL/api/auth/token"
```

## ブラウザの操作が403 `invalid_origin`になる

画面を開いたURLが、許可したoriginと違います。LANやVPNのIPアドレスで開く場合は`MMT_ALLOW_PRIVATE_ORIGINS=true`を、DNS名で開く場合は`MMT_WEB_ORIGIN`と`MMT_PUBLIC_URL`にそのURLを設定して、APIを再起動します。

## Projectの権限を変えられない（409）

「Project adminがいなくなるため変更できません。」と表示される場合は、最後のAdminを外そうとしています。先に別のメンバーかgroupへAdminを付けてください。全体管理者を無効化・降格しようとして409 `last_global_admin`になる場合も、先に別の全体管理者を用意します。

## 通知が届かない

1. ［プロジェクト設定］の「通知」の通知先で、［送信設定］が「設定済み」かを確かめます。「未設定」なら、API serverの`.env`に環境変数が無いか、APIを再起動していません。
2. ［テスト送信］で、その場で送れるかを確かめます。
3. 「直近の送信履歴」で、状態と失敗の理由を確かめます。理由ごとの確認項目は[通知と運用アラート](/admin/notifications)の「送信の流れと失敗したとき」にあります。
4. 通知ルールが有効で、イベントと条件が合っているかを確かめます。workerの停止とPlugin送信の滞留は、実行種別や実験の条件を付けたルールには届きません。

## Pluginにつながらない・送信が滞る

| 表示 | 直し方 |
| --- | --- |
| Pluginのtoken環境変数が設定されていません（`plugin_token_unavailable`） | API serverの`.env`に、登録した変数名でPluginのtokenを入れ、APIを再起動する |
| ［接続を確認］が失敗する | Pluginが動いているか、接続先URLにAPI serverから届くかを確かめる。PluginとAPI serverの`MMT_PLUGIN_TOKEN`の値が同じかを確かめる |
| 運用アラート「Plugin送信の滞留」 | ［Plugins］の「イベントの送信状況」で最終エラーを確かめ、Pluginを直してから［イベントを再送］を押す |

## workerがJobを受け取らない・停止と表示される

workerのホストで次を実行します。

```sh
mado-tracking-worker status --worker-id gpu-host-1
mado-tracking-worker doctor --worker-id gpu-host-1
journalctl --user -u mado-tracking-worker@gpu-host-1 -f
```

- `doctor`がtokenのscopeのerrorを出す場合は、Service Accountのtokenに`read`、`worker:execute`、`artifacts:write`があるかを確かめます。
- tokenが401になる場合は、期限切れか、Service Accountが無効になっていないかを確かめます。新しいtokenは`mado-tracking-worker install --token-file`で差し替えます。
- Compute targetの「接続を確認」は、`MMT_WORKER_TARGET_IDS`にそのtargetを含むworkerだけが行います。

詳しくは[worker](/compute/worker)を参照してください。

## コンピュータが実行先に出ない・Jobを作れない（`target_not_available`）

- 実行先には、自分が使えるコンピュータだけが出ます。全体設定の「コンピュータ」の［自分が使えるか］で確かめます。
- ほかの人のPrivateのコンピュータは使えません。全体管理者も同じです。所有者にPublicにしてもらうか、自分のコンピュータを足します。
- 自動実行ルール・フック・Sweepは、それぞれの所有者で判定します。ルールをService Accountへ移したときは、そのService Accountをコンピュータの所有者が作ったかを確かめます。
- 待機中のJobが`submit_failed`で失敗したときは、Jobを作ったあとでコンピュータがPrivateに変わった可能性があります。
- siteのjob shell・鍵・自分の設定を開いて403 `target_not_available`になるのも、そのコンピュータを使えないためです。

詳しくは[コンピュータと公開範囲](/compute/computers)を参照してください。

## Runの終了後の処理が欠けている

出力モデルの登録など、Runの終了後の処理が失敗すると、APIの標準エラー出力に次の1行が出ます。Runの終了とGPUの解放は確定しています。自動では再実行しないので、そのRunの登録記録や自動実行の記録が欠けていないかを確かめてください。

```json
{"event":"run_completion_handler_failed","handler":"<処理の名前>","runId":"<Run ID>","message":"<エラー>"}
```

## 保存先のArtifactが503になる

`MMT_STORAGE_SECRET_KEY`を変えると、画面で追加したS3の保存先のシークレットを復号できなくなります。APIの起動時に`storage_backend_unavailable`がログに出ます。「全体管理」→［ストレージ］で、各S3の保存先のシークレットを入れ直してください（[保存先](/data/storage)）。
