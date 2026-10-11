---
title: Authentik（SSO）
description: AuthentikのApplicationとProviderの作り方、scopeとgroups、ログインを許すgroupと全体管理者のgroup、groupでProjectの権限を付ける方法。
---

# Authentik（SSO）

AuthentikのOIDC（Authorization Code Flow＋PKCE）でログインします。MFA、パスワードの規則、アカウントの復旧、ログインの流れはAuthentikで管理し、このアプリはユーザー、全体管理者の判定、ブラウザのsession、監査ログを管理します。Projectの中の権限はこのアプリで設定します。

権限は次の2段で決まります。

| 段 | 決め方 | 変える場所 |
| --- | --- | --- |
| ログインできるか・全体管理者か | Authentikのgroupと、API serverの環境変数の対応表 | Authentikのgroupの所属と`.env` |
| ProjectのRole（Viewer／Editor／Admin） | 人への直接付与と、groupへの付与のうち強い方。PublicのProjectでは、ログインできる全員がEditor | ［プロジェクト設定］ |

## 1. Authentikに登録する

AuthentikでApplicationとOAuth2/OpenID Providerを作ります。下の`https://tracking.example.com`は、このアプリの実際のHTTPSのURL（`MMT_PUBLIC_URL`）に置き換えてください。

1. Authentikの管理画面で［Applications］→［Providers］→［Create］を選び、［OAuth2/OpenID Provider］を作ります。
2. 次の値を設定します。

| 項目 | 値 |
| --- | --- |
| Client type | Confidential |
| Redirect URIs | `https://tracking.example.com/api/auth/callback`（完全一致） |
| Scopes | `openid`、`profile`、`email`、`offline_access`の各mapping |
| Back-channel logout URI | `https://tracking.example.com/api/auth/oidc/backchannel-logout` |

3. ［Applications］→［Create］でApplicationを作り、上のProviderを選びます。slugは例として`ml-tracking`にします。
4. ProviderのClient IDとClient Secretを控えます。Client SecretはAPI serverの`.env`にだけ置きます。

IssuerのURLはApplication単位で、slugが`ml-tracking`なら`https://sso.example.com/application/o/ml-tracking/`です。

### scopeとgroups

ID tokenとUserInfoの両方に、次のclaimが必要です。

- `email`と`email_verified`（`email_verified`がtrueでないログインは拒否します）
- `name`（表示名）
- `groups`（group名の配列）

UserInfoに`groups`が無いと、ログイン後の再確認で「どのgroupにも入っていない」と判定され、全員のsessionが切れます。Providerのscope mappingで`groups`が出ていることを確かめてください。

`offline_access`（Authentik標準の「authentik default OAuth Mapping: OpenID 'offline_access'」）は、refresh tokenを発行させるために入れます。入れなくても動きますが、Authentikのaccess tokenの期限（Providerの［Access token validity］。既定は5分）が切れるたびに、ログインし直しが必要になります。

## 2. API serverを設定する

API serverの`.env`に次を入れます。本番ではHTTPSが必須です。導入中はローカルの管理者を緊急用に残すため、`hybrid`にします（[認証方式](/admin/auth)の「SSOへ移行する」）。

```dotenv
NODE_ENV=production
AUTH_MODE=hybrid
MMT_PUBLIC_URL=https://tracking.example.com
MMT_WEB_ORIGIN=https://tracking.example.com
OIDC_ISSUER_URL=https://sso.example.com/application/o/ml-tracking/
OIDC_CLIENT_ID=<ProviderのClient ID>
OIDC_CLIENT_SECRET=<ProviderのClient Secret>
OIDC_LABEL=Authentik
OIDC_SCOPES=openid profile email offline_access
OIDC_ALLOWED_GROUPS=mmt-users,mmt-admins
OIDC_ROLE_MAPPING_JSON={"mmt-admins":"admin","mmt-users":"user"}
OIDC_DEFAULT_ROLE=user
OIDC_AUTO_LINK_VERIFIED_EMAIL=false
MMT_SESSION_ENCRYPTION_KEY=<下のコマンドで作った値>
OIDC_RECHECK_SECONDS=60
OIDC_TOKEN_SYNC_MAX_AGE_SECONDS=604800
```

`MMT_SESSION_ENCRYPTION_KEY`は、sessionに保存するAuthentikのtokenを暗号化する鍵です。ターミナルで作り、`.env`にだけ書きます。保存先の鍵（`MMT_STORAGE_SECRET_KEY`）とは別の値にしてください。

```sh
openssl rand -base64 32
```

設定を変えたらAPIを再起動します。各変数の意味は[環境変数](/reference/environment)の「認証とSSO」にまとめています。

### ログインを許すgroupと全体管理者のgroup

- `OIDC_ALLOWED_GROUPS`: ログインを許すgroup（カンマ区切り）。`oidc`と`hybrid`では必須で、空ならAPIが起動しません。どのgroupにも入っていない人はログインできず、ユーザーも作られません。
- `OIDC_ROLE_MAPPING_JSON`: group→全体のroleの対応表。roleは`admin`（全体管理者）と`user`（ログインだけ）の2つです。ほかの値はAPIの起動時にエラーになります。
- `OIDC_DEFAULT_ROLE`: 対応表のどのgroupにも入っていない、許可された人のrole。既定は`user`です。
- `OIDC_ADMIN_GROUP`: `{"<group>":"admin"}`の省略形です。対応表と両方を書いて、adminのgroupが食い違うとAPIが起動しません。どちらも書かなければ、`mmt-admins`が全体管理者のgroupになります。

複数のgroupに入っている人は、強い方（`admin`）になります。対応表に書いたgroupも`OIDC_ALLOWED_GROUPS`に入れてください。許可されていないgroupだけの人は、対応表に関係なくログインできません。

| Authentikのgroupの例 | `OIDC_ALLOWED_GROUPS` | 対応表のrole | 結果 |
| --- | --- | --- | --- |
| `mmt-admins` | 含む | `admin` | ログインでき、全体管理者になる |
| `mmt-users` | 含む | `user` | ログインできる。PublicのProjectはEditorとして使える。それ以外の権限は別に付ける |
| `mmt-proj-asr-editors`だけ | 含まない | — | ログインできない |
| `mmt-users`と`mmt-proj-asr-editors` | `mmt-users`を含む | `user` | ログインでき、`mmt-proj-asr-editors`への付与も効く |

### 確かめる

1. ブラウザでこのアプリを開き、ログイン画面に［Authentik］（`OIDC_LABEL`の値）のボタンが出ることを確かめます。
2. `mmt-admins`の人がSSOでログインし、ユーザーメニューの［全体設定］を開いて、サイドバーに「全体管理」の組（プロジェクト、ユーザーなど）が出ることを確かめます。
3. `mmt-users`だけの人がSSOでログインし、ユーザーメニューの［全体設定］を開いて、サイドバーに「全体設定」の組（アカウント、コンピュータ）は出て、「全体管理」の組は出ないことを確かめます。
4. どちらかのgroupに入っていない人がログインを断られることを確かめます。断られた理由は監査ログの「SSOログインの拒否」（`auth.oidc.denied`）に残ります（[トラブルシューティング](/reference/troubleshooting)の「SSOでログインできない」）。

## ログインのたびに同期すること

- 初めてSSOでログインした人のユーザーを作ります。自分で登録する画面はありません。
- ログインのたびに、全体管理者かどうかと、その人のgroupを同期します。全体管理者の判定を画面から変えても、次のログインでAuthentik側の状態へ戻ります。恒久的に変えるときはAuthentikのgroupを変えます。
- 表示名とメールアドレスは、ログインのたびにAuthentikの値へ更新します。
- 同期で有効な全体管理者が0人になる場合は、そのログインを拒否します（`last_admin`）。
- 作成・連携と、全体のroleやgroupの変化は監査ログの「SSOのgroupと権限の同期」（`auth.oidc.sync`）に残ります。

### 同じメールアドレスのローカルアカウント

既定（`OIDC_AUTO_LINK_VERIFIED_EMAIL=false`）では、同じメールアドレスのローカルアカウントがあっても、SSOのユーザーは別のユーザーになります。`true`にすると、次の条件をすべて満たすときだけ、ローカルアカウントへ結び付けます。

- `email_verified`がtrue
- メールアドレスが一致する（大文字小文字は区別しません）、まだSSOと結び付いていないローカルアカウントが1人だけ
- そのローカルアカウントが全体管理者でも、どこかのProjectのAdminでもない

特権を持つローカルアカウントを自動で結び付けないのは、Authentik側のアカウントで管理者を乗っ取れないようにするためです。この場合のログインは`privileged_link_required`で拒否します。

## ログイン中の権限の再確認

Authentikでgroupから外した人の権限を、次のログインを待たずに止める仕組みです。

- SSOでログインしたsessionは、`OIDC_RECHECK_SECONDS`（既定60秒）ごとに、AuthentikのUserInfoで現在のgroupを確かめ直します。access tokenが切れていれば、refresh tokenで更新してから確かめます。
- 許可されたgroupに入ったままなら、groupと全体管理者の判定を更新して続けます。ProjectのRoleは次の要求から変わります。
- 許可されたgroupから外れていれば、その人の**すべての**SSOのsessionを終了し、API tokenも止めます。
- Authentikがtokenを拒否した（Authentikでログアウトした、ユーザーを無効にした、refresh tokenが失効した）ときは、そのsessionを終了します。
- Authentikに接続できないときは、503 `oidc_unavailable`を返し、sessionは残します。確認できない権限では操作させません。Authentikが復旧すれば、同じsessionで続けられます。

ローカルアカウントのsessionとAPI tokenの要求では、Authentikに問い合わせません。

### Back-channel logout

AuthentikのProviderに［Back-channel logout URI］を登録すると、Authentikでユーザーやsessionを終了した時点で、このアプリのsessionも終了します。記録は監査ログの「SSOからのログアウト」（`auth.oidc.backchannel_logout`）に残ります。

### SSOのユーザーのAPI token

API tokenだけを使い続けると、groupの変化に気付けません。そこで、SSOのユーザーのAPI tokenは、最後のgroupの同期（ログインか再確認）から`OIDC_TOKEN_SYNC_MAX_AGE_SECONDS`（既定7日）までしか使えません。過ぎると401 `identity_sync_required`になります。tokenは失効しないので、ブラウザで一度ログインすれば同じtokenがまた使えます。

workerや自動実行、CIのように長く動くものには、人のtokenではなくService Accountのtokenを使ってください。Service Accountはこの期限の対象外です（[API tokenとService Account](/admin/tokens)）。

## groupでProjectの権限を付ける

人ごとにRoleを付ける代わりに、AuthentikのgroupにProjectのRoleを付けられます。

1. Authentikで、Projectごとのgroupを作ります（例: `mmt-proj-asr-editors`）。
2. 使う人をgroupに入れ、一度SSOでログインしてもらいます。
3. ［プロジェクト設定］を開き、「Authentik group」の［groupを追加］を押します。
4. group名とRoleを入力して保存します。

| 項目 | 入力値 |
| --- | --- |
| group名 | Authentikのgroup名をそのまま。大文字小文字と空白も含めて完全一致です。例: `mmt-proj-asr-editors` |
| Role | `Viewer`、`Editor`、`Admin`のどれか |

group名の候補には、一度でも誰かのログインで同期されたgroupだけが出ます。まだ誰もログインしていないgroupは、名前を直接入力します。

保存すると、「Members」の一覧にそのgroupの人が「group mmt-proj-asr-editors」の付与元つきで表示されます。これで設定できています。

`OIDC_ALLOWED_GROUPS`に入れる必要はありません。ただし、そのgroupの人も、許可されたgroupのどれかに入っていないとログインできません。

groupの所属は、ログインと再確認（既定60秒ごと）で同期します。Authentikでgroupに入れた人は、ログイン中でも1分ほどで権限が付きます。外した人は1分ほどで権限が外れます。ブラウザを使わずAPI tokenだけを使っている人は、次の同期までは元のgroupのままです。すぐ止めたいときは、Projectで付与を外すか、tokenを失効させてください。

実効Roleの決まり方は[権限とRole](/admin/permissions)で説明します。
