# 運用と接続設定

## 認証方式（AUTH_MODE）

`AUTH_MODE`でログイン方法を選びます。既定は`hybrid`です。

| AUTH_MODE | 使えるログイン | 必須の設定 | 向いている場面 |
|---|---|---|---|
| `local` | ローカルアカウント | なし（`OIDC_*`は読まない） | SSOが無い環境、閉じたLAN |
| `oidc` | Authentik（SSO）だけ | `OIDC_ISSUER_URL`、`OIDC_CLIENT_ID`、`OIDC_ALLOWED_GROUPS` | SSOへ移行し終えた本番 |
| `hybrid` | SSOとローカルアカウント | `OIDC_ISSUER_URL`、`OIDC_CLIENT_ID`、`OIDC_ALLOWED_GROUPS` | SSOの導入中。Local Adminを緊急経路に残す |
| `development` | 開発用ログイン | なし | ローカル開発。`NODE_ENV=production`では起動しない |

必須の設定が欠けると、APIは設定名だけを示して起動しません。無効なmodeの経路は404を返します（`local`のOIDC開始・callback、`oidc`の`POST /api/auth/local-login`）。

Web sessionはidle期限`AUTH_SESSION_IDLE_SECONDS`（既定28800=8時間）とabsolute期限`AUTH_SESSION_ABSOLUTE_SECONDS`（既定43200=12時間）の早い方で切れます。idleがabsoluteを超える設定は起動時に拒否します。SSOボタンの表示名は`OIDC_LABEL`（既定`Authentik`）です。

ローカルアカウントのパスワードはArgon2id（memory 19456KiB、time 2、parallelism 1）で保存し、12〜1024 byteを受け付けます。ログインは接続元ごとに1分30回、同じユーザー名への失敗は15分10回、パスワード変更時の現在のパスワード確認はユーザーごとに15分10回までで、超えると429と`Retry-After`を返します。回数はAPIプロセスのメモリにあり、再起動で戻ります。Argon2の同時計算は4件までです。存在しないユーザー名、誤ったパスワード、無効化したユーザーは同じ401を返します。ログイン・ログアウト・パスワード変更・初期管理者の作成は監査ログ（`audit_events`の`auth.login`、`auth.logout`、`auth.password.change`、`auth.bootstrap_admin`）に残り、パスワードやOIDCのcode・stateは記録しません。回数制限で429になった試行は記録しません。

### 初期管理者（bootstrap-admin）

API serverの端末で対話的に実行します。ユーザー名とパスワードは端末から入力し、コマンド引数やログには出しません。

```sh
npm run bootstrap-admin -w @mmt/api
```

同じユーザー名が既にあれば、全体管理者・有効に戻してパスワードを置き換え、そのユーザーのsessionを失効させます。作成・再設定したアカウントは次のログインでパスワードの変更が必要で、変更するまで`GET /api/auth/config`・`GET /api/auth/me`・`POST /api/auth/change-password`・`POST /api/auth/logout`以外は403 `password_change_required`になります。パスワードを変更すると、同じユーザーのほかのsessionは失効します。ローカルアカウントの利用者は、右上のユーザーメニュー（アバター）の「パスワードの変更」（`/settings/account/password`）からいつでも変更できます。

### SSOへの移行手順

1. `AUTH_MODE=hybrid`とAuthentikの設定（下記）を入れて`npm run db:migrate`の後にAPIを再起動し、`bootstrap-admin`でLocal Adminを作ってパスワードを変更します。
2. 管理者と一般メンバーがSSOでログインし、全体管理者の判定とProject権限が正しいことを確認します。migration 010で既存のSSOユーザーは`user_oidc_identities`へ移り、同じユーザーIDのままログインできます。
3. 確認できたら`AUTH_MODE=oidc`へ変えて再起動します。Local Adminのログインは404になります。SSOが止まったときは`hybrid`へ戻すとLocal Adminでログインできます。

migration 010はsessionに`auth_method`を必須で追加します。migration後は新しいAPIへ入れ替えてください（古いAPIはsessionを作れません）。

### ユーザーを止める・戻す（退職・異動）

1. 全体管理者がブラウザでサイドバーの「全体管理」→「ユーザー」（`/settings/users`）を開き、対象の行で「無効化」を押します。そのユーザーのsessionは直ちに終了し、API token（MLflow互換APIを含む）も直ちに401になります。SSOユーザーはAuthentik側でもgroupから外します。外さずに再有効化すると、次回loginでgroup由来の全体roleに戻ります。
2. 戻すときは同じ行で「有効化」を押します。API tokenは再び使えますが、終了したsessionは戻りません（再loginが必要）。
3. 最後の有効な全体管理者は無効化・降格できません（409 `last_global_admin`）。先に別の管理者を用意します。
4. ユーザーは削除しません。Runやモデルバージョンの作成者の記録を保つためです。

### ローカルアカウントのパスワードを忘れた

全体管理者が「全体管理」→「ユーザー」で「パスワード再設定」を押すと、一時パスワードが1回だけ表示されます。本人へ安全な経路で渡してください。本人の既存sessionは終了し、次回loginでパスワードの変更を求められます。全体管理者自身が締め出された場合は、上の`bootstrap-admin`で復旧します。

## 監査ログ

認証（上記と、SSOの同期・拒否の`auth.oidc.sync`・`auth.oidc.denied`。下の「Authentik」）、Projectメンバーの権限変更（`project.member.set`、`project.member.delete`）、SSO groupへのProject権限の付与（`project.group_binding.set`、`project.group_binding.delete`）、API tokenの発行・失効（`token.create`、`token.revoke`）、Service Accountの作成・変更（`service_account.create`、`service_account.update`）、全体管理者によるユーザーの作成・変更・パスワード再設定（`admin.user.create`、`admin.user.update`（変更前後のstatus・isAdmin・表示名）、`admin.user.password_reset`）を`audit_events`に記録します。業務の変更と同じtransactionで書くので、変更が戻れば記録も残りません。権限不足（403）と競合（409）で拒否した操作は、transactionの外で`outcome=denied`と`details.code`付きで残します。入力の検証エラーや存在しない対象は記録しません。token原文・hash・パスワードは記録せず、接続元IPとUser-Agentを残します。監査ログは無期限に保存し、削除機能はありません。

Project adminは「プロジェクト設定」の「監査ログ」で自分のProjectの記録を新しい順に読めます。Projectに属さない記録（ログインなど）を含む全体の一覧は`GET /api/audit-events`で、全体管理者のsessionだけが読めます（API tokenでは読めません）。

## Authentik

アプリはOIDC Authorization Code Flow + PKCEを使います。MFA、password policy、recovery、login flowはAuthentikを正本とし、アプリはUser、全体role、browser session、監査ログを管理します。Project内の権限はアプリで設定します。

### Authentikに登録する値

`https://tracking.example.com`は実際のHTTPS URL（`MMT_PUBLIC_URL`）へ置き換えます。

| 項目 | 値 |
|---|---|
| Redirect URI | `https://tracking.example.com/api/auth/callback`（完全一致） |
| Issuer | application単位のURL（例: `https://sso.example.com/application/o/ml-tracking/`） |
| Scope | `openid profile email offline_access`（`OIDC_SCOPES`と同じにする。`offline_access`は下の「sessionの再確認」） |
| Back-channel logout URI | `https://tracking.example.com/api/auth/oidc/backchannel-logout` |

AuthentikではApplicationとOAuth2/OpenID Providerを作ります。client secretはAPI serverにだけ設定します。ID tokenと**UserInfo**に`email`、`email_verified`、`name`、`groups`（group名の配列）を出すscope mappingが必要です。UserInfoに`groups`が無いと、次の再確認でどのgroupにも入っていないと判定され、全員のsessionが切れます。Providerの設定方法は[Authentik公式資料](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)を参照してください。

refresh tokenを発行させるため、Providerのscope mappingに`offline_access`（Authentik標準の「authentik default OAuth Mapping: OpenID 'offline_access'」）を加え、`OIDC_SCOPES`にも`offline_access`を入れます。Authentikで有効にできない場合は`offline_access`を外したままでも動きますが、access tokenの期限（Authentikの既定は5分。Providerの「Access token validity」）ごとに再ログインが必要になります。

アプリはstate、nonce、PKCE、ID tokenの署名・issuer・audienceを検証します。OIDC開始時に短命のHttpOnly cookieを発行し、callbackは同じbrowserからだけ受け付けます。

### 設定例

導入時はLocal Adminを緊急経路として残すため`hybrid`を推奨します（上の「SSOへの移行手順」）。本番ではHTTPSが必須です。

```dotenv
NODE_ENV=production
AUTH_MODE=hybrid
MMT_PUBLIC_URL=https://tracking.example.com
MMT_WEB_ORIGIN=https://tracking.example.com
OIDC_ISSUER_URL=https://sso.example.com/application/o/ml-tracking/
OIDC_CLIENT_ID=<providerのclient ID>
OIDC_CLIENT_SECRET=<secret>
OIDC_LABEL=Authentik
OIDC_SCOPES=openid profile email offline_access
OIDC_AUTO_LINK_VERIFIED_EMAIL=false
OIDC_ALLOWED_GROUPS=mmt-users,mmt-admins
OIDC_ROLE_MAPPING_JSON={"mmt-admins":"admin","mmt-users":"user"}
OIDC_DEFAULT_ROLE=user
# openssl rand -base64 32 で作る。MMT_STORAGE_SECRET_KEYとは別の値にする
MMT_SESSION_ENCRYPTION_KEY=<base64の32 byte>
OIDC_RECHECK_SECONDS=60
OIDC_TOKEN_SYNC_MAX_AGE_SECONDS=604800
```

| 設定 | 意味 |
|---|---|
| `OIDC_ALLOWED_GROUPS` | loginを許すgroup（カンマ区切り）。`oidc`/`hybrid`で必須で、空なら起動しません |
| `OIDC_ROLE_MAPPING_JSON` | group→全体roleの対応表。roleは`admin`（全体管理者）と`user`（loginのみ）。ほかの値は起動時エラー |
| `OIDC_DEFAULT_ROLE` | 対応表のどのgroupにも入っていない許可ユーザーの全体role。既定`user` |
| `OIDC_ADMIN_GROUP` | `{"<group>":"admin"}`の省略形（以前からの設定）。対応表と両方指定して、adminのgroupが食い違うと起動しません。どちらも無ければ`mmt-admins`をadminとします |
| `OIDC_AUTO_LINK_VERIFIED_EMAIL` | 同じemailのLocal Userへ自動連携するか。既定`false` |
| `OIDC_SCOPES` | 要求するscope。既定`openid profile email`。`openid`が無いと起動しません。refresh tokenを使うには`offline_access`を足します |
| `MMT_SESSION_ENCRYPTION_KEY` | SSO sessionに保存するaccess/refresh tokenの暗号鍵（base64の32 byte、AES-256-GCM）。`oidc`/`hybrid`で必須で、無いか形式が違うと起動しません |
| `OIDC_RECHECK_SECONDS` | SSO sessionをUserInfoで確かめ直す間隔（秒）。既定`60` |
| `OIDC_TOKEN_SYNC_MAX_AGE_SECONDS` | SSOユーザーのAPI tokenを使える、最後のgroup同期からの期限（秒）。既定`604800`（7日）。60未満は起動時エラー |

対応表に書いたgroupも`OIDC_ALLOWED_GROUPS`に入れてください。許可groupに無いgroupだけを持つ人は、対応表に関係なくloginできません。

以前のバージョンから更新するときは、`OIDC_ALLOWED_GROUPS`を足してから再起動してください（無いとAPIが起動しません）。`OIDC_ADMIN_GROUP`だけの設定は、そのまま同じ全体管理者の判定になります。

migration 042を含むバージョンへ更新するときは、先に`MMT_SESSION_ENCRYPTION_KEY`を`.env`へ足します（無いとAPIが起動しません）。042はtokenを持たない既存のSSO sessionを失効させるので、SSOの利用者は更新後に一度ログインし直します。Local sessionはそのまま使えます。鍵を変えると、保存済みのtokenを復号できないSSO sessionは次の再確認で失効し、再ログインになります。

### Userと全体roleの同期規則

- 初回SSOでUserをJIT作成します。self-signupの画面はありません。
- `OIDC_ALLOWED_GROUPS`のどのgroupにも入っていない人は拒否し、Userも作りません。
- loginとsessionの再確認のたびに、全体管理者かどうか（`users.is_admin`）を対応表から同期します。複数groupに該当すれば強い方（`admin`）になります。
- loginとsessionの再確認のたびに、その人のgroupを`user_groups`へ保存し直します。ProjectのSSO group bindingはこの表を使います。
- 同期で有効な全体管理者（Local Adminを含む）が0人になる場合は、そのloginを拒否し、`is_admin`を残します。
- 既存Local Userへのemail自動連携は既定で無効で、同じemailでも別のUserになります。有効にした場合も`email_verified=true`かつemail一致（大文字小文字を区別しない）で、まだSSOと結び付いていないLocal Userが1人だけのときに限ります。全体管理者やどこかのProject adminであるLocal Userは自動連携しません。
- `email_verified`がtrueでないloginは拒否します。
- SSO由来の表示名とemailはloginのたびに更新します。Local UserのユーザーIDは連携後も維持します。
- 作成・連携、全体roleやgroupの変化は監査ログの`auth.oidc.sync`に残ります。

Role同期を使う環境では、SSO Userの全体roleを画面から一時的に変えても次回ログインでAuthentik側の状態へ戻ります。恒久変更はAuthentik groupで行います。

Web sessionはHttpOnly/SameSite=Lax cookieで、期限は上の`AUTH_SESSION_*`に従います。変更操作はOriginを検証します。アプリからのlogoutはアプリsessionを失効させます。Authentik全体のsession logoutとSCIMは提供しません。

### sessionの再確認とback-channel logout

Authentikでgroupから外した人の権限を、loginを待たずに止める仕組みです（Madoと同じ構成）。

- SSOのlogin時に、Authentikのaccess tokenとrefresh tokenを`MMT_SESSION_ENCRYPTION_KEY`で暗号化してsessionへ保存します（`sessions.access_token_enc`・`refresh_token_enc`）。平文では保存しません。sessionを失効させるとtokenも消します。
- SSO sessionの要求ごとに、最後の確認から`OIDC_RECHECK_SECONDS`（既定60秒）が過ぎているか、access tokenの期限が切れていれば、UserInfoで現在のgroupを確かめます。access tokenが切れていればrefresh tokenで更新してから聞きます。同じsessionへ同時に来た要求は1回の確認を待ち合わせます。
- 結果はloginと同じ規則で反映します（上の「Userと全体roleの同期規則」）。
  - 許可groupに入ったまま: `user_groups`と`is_admin`を更新して続けます。全体roleやProject roleの変化ではsessionを切りません（Project権限は`effective_project_roles`で次の要求から変わります）。
  - 許可groupから外れた（ほかの拒否理由も同じ）: その人のSSO identityの**全session**を失効させ、`user_groups`を空にし、API tokenも止めます（下の「SSOユーザーのAPI token」）。
  - Authentikがtokenを拒否した（401、`invalid_grant`。Authentikでlogoutした、Userを無効にした、refresh tokenが失効した）: そのsessionを失効させます。
  - refresh tokenが無く（`offline_access`無し）access tokenが切れた: そのsessionを失効させ、再ログインを求めます。
  - Authentikに届かない（接続できない、5xx）: **503 `oidc_unavailable`**を返し、sessionは残します。未確認の権限では通しません。復旧すれば同じsessionで続けられます。
- Local sessionとAPI tokenの要求ではAuthentikを呼びません。
- 失効させた記録は監査ログの`auth.oidc.recheck`（`outcome=denied`、`details.reason`・`details.scope`（`session`か`identity`）・`details.revokedSessions`）と、標準エラー出力の1行JSON（`{"event":"oidc_session_revoked",...}`）に残ります。Authentikに届かなかったときは`{"event":"oidc_session_check_failed",...}`を出します。

| `auth.oidc.recheck`の`reason` | 意味 |
|---|---|
| `group_not_allowed` | 許可groupから外れた。identityの全sessionを失効 |
| `idp_session_revoked` | Authentikがaccess/refresh tokenを拒否した |
| `reauthentication_required` | refresh tokenが無いままaccess tokenが切れた、tokenを持たない旧session、鍵の変更でtokenを復号できない |
| `last_admin`・`user_disabled`ほか | loginの拒否理由と同じ（上の切り分け表） |

Back-channel logout: AuthentikのProviderに上の「Back-channel logout URI」を登録すると、AuthentikでUserやsessionを終了した時点で、アプリのsessionも失効します。アプリはlogout tokenの署名（ProviderのJWKS）・issuer・audience（`OIDC_CLIENT_ID`）・発行時刻（10分以内）・`events`・`jti`を検証し、`nonce`を含むものは拒否します。`sub`があればそのidentityの全session、`sid`だけならそのAuthentik sessionで作ったsessionを失効させます。同じ`jti`の再送は400 `logout_token_replayed`です。記録は監査ログの`auth.oidc.backchannel_logout`（`details.subject`・`details.sid`・`details.revokedSessions`）です。

### SSOユーザーのAPI tokenの同期期限

group同期はブラウザのloginかsessionの再確認でしか起きません。API tokenだけを使い続けると、Authentikでgroupから外しても気付けないため、SSO identityを持つUserのAPI tokenは**最後のgroup同期から`OIDC_TOKEN_SYNC_MAX_AGE_SECONDS`（既定7日）まで**しか使えません。期限を過ぎたtokenは401 `identity_sync_required`になります（tokenは失効させません）。

- SDKだけを使う研究者のtokenは、ブラウザで7日間ログインしないと止まります。**ブラウザで一度ログインすれば、同じtokenがそのまま使えるようになります。**
- 長期に動くworker・自動実行・CIは、人のtokenではなくService Account（上の「workerホストへworkerを導入する」の1.）のtokenを使います。Service Accountはこの期限の対象外です。
- 自動実行のrule・自動昇格のpolicy・フックの所有者（実行するUser）には、この期限を掛けません。どれもサーバーの中で所有者の権限を確かめて動き、Jobに渡すJob tokenも期限を見ません。所有者がProjectの権限を失う（Projectから外れる・無効化される）と止まるので、長く使うものはProjectの設定でService Accountへ移します（所有者の移管。Project adminが行い、移管先は同じProjectの有効なService Accountで、ruleとpolicyはRoleがadmin、フックはeditorかadmin）。APIではruleが`PUT /api/projects/:p/automation-rules/:id/owner`、policyが`PUT /api/projects/:p/promotion-policies/:id/owner`、フックが`PUT /api/projects/:p/hooks/:id/owner`で、bodyはどれも`{serviceAccountId}`。移管先が条件に合わなければ422（ruleは`invalid_automation_owner`、policyは`promotion_owner_invalid`、フックは`invalid_hook_owner`）です。
- 期限が無い代わりに、Authentikでgroupから外した人が所有するrule・policy・フックは、次にgroupが同期される（その人のログインか、使用中のsessionの再確認）までgroup由来の権限で動き続けます。すぐ止めるときは、全体管理者がユーザーを無効化する（上の「ユーザーを止める・戻す」）か、所有者をService Accountへ移します。
- emailで自動連携したLocal UserもSSO identityを持つので対象です。ローカルアカウントでログインしてもgroupは同期されないため、SSOで一度ログインします。
- `AUTH_MODE=local`へ切り替えた後も、SSO identityを持つUserのtokenは期限で止まります。

### SSOで入れないときの切り分け

callbackで断ったときは、利用者には理由を区別せず401を返します。理由はAPIの標準エラー出力の1行JSON（`{"event":"oidc_login_denied","reason":"<reason>","userId":...}`）と、監査ログの`auth.oidc.denied`（`details.reason`、`details.subject`、`details.email`）に残ります。全体の監査ログは全体管理者が`GET /api/audit-events?action=auth.oidc.denied`で読めます。tokenやcodeは出しません。

| `reason` | 意味 | 直し方 |
|---|---|---|
| `group_not_allowed` | `OIDC_ALLOWED_GROUPS`のどのgroupにも入っていない | Authentikでgroupに入れる。ID tokenに`groups`が出ているかも確認する |
| `email_not_verified` | ID tokenの`email`が無いか、`email_verified`がtrueでない | Authentikでemailを検証済みにし、scope mappingで`email_verified`を出す |
| `user_disabled` | アプリでそのUserが無効になっている | 全体管理者がUserを有効に戻す |
| `last_admin` | groupの同期で、最後の有効な全体管理者を外そうとした | 別の全体管理者（Local Adminでもよい）を先に用意する |
| `privileged_link_required` | 自動連携が有効で、検証済みemailが特権を持つLocal Userと一致した | 乗っ取りを防ぐため自動では連携しない。管理者がLocal Userの権限を確認して対応する |

これ以外の401（`event`が`oidc_authentication_failed`の行や、監査ログ`auth.login`の`details.reason`が`invalid_oidc_state`）は、IdPとの通信、stateの期限切れ、開始したbrowserとの不一致などの問題です。

### 接続元とメンバーの登録

LAN/VPNから使う場合は`MMT_ALLOW_PRIVATE_ORIGINS=true`を設定します。CORS、ログイン/logout、sessionの変更操作で同じ判定を使い、HTTP(S)のIPv4 private・loopback・link-local・CGNAT、IPv6 ULA・loopback・link-localとlocalhostを許可します。設定省略時はfalseです。DNS名で使う場合は`MMT_WEB_ORIGIN`と`MMT_PUBLIC_URL`へ実際のURLを設定してください。Originが欠落/nullの場合や、許可されていないpublic IP・DNS名は拒否します。Bearer API tokenは従来どおりOriginなしで使えます。

開発Webはport5182でLANから接続できます。`/api`はloopbackのAPI4182へproxyします。Authentikのcallbackは`MMT_PUBLIC_URL`の固定URLを使うので、SSOで使うURLはProviderにも完全一致で登録します。

初回に管理者がloginしProjectを作成します。メンバー（`OIDC_ALLOWED_GROUPS`のgroupに入っている人）は一度SSOでloginするとユーザーIDが作られ、「プロジェクト設定」からviewer/editor/adminを付けられます（Privateの場合。PublicのProjectは、ログインできる全員がメンバーへの追加なしにeditorとして使えます）。人ごとに付ける代わりに、AuthentikのgroupへProjectのroleを付けることもできます（次の節）。API tokenは発行時のscopeに加え、その所有者の現在のProject権限を確認します。

### 権限の決まり方

権限は2段です。

| 段 | 決め方 | 変える場所 |
|---|---|---|
| 全体role（全体管理者か否か） | `OIDC_ROLE_MAPPING_JSON`（と`OIDC_ADMIN_GROUP`）の対応表。loginとsessionの再確認のたびに同期 | API serverの環境変数とAuthentikのgroup |
| Project role（viewer/editor/admin） | 直接付与とgroup bindingのうち強い方 | 「プロジェクト設定」（Project admin） |

- 直接付与はユーザー1人に付けるrole（`project_members`）、group bindingはAuthentikのgroup名に付けるrole（`project_group_bindings`）です。どちらもProject adminが設定し、監査ログに`project.member.set`・`project.member.delete`・`project.group_binding.set`・`project.group_binding.delete`として残ります。
- 実効roleは、直接付与と、その人が入っているgroupのbindingのうち最も強いroleです。直接viewer＋group editorならeditorです。判定はすべてDBのview `effective_project_roles`で行い、画面・native API・MLflow互換API・API token・Job tokenで同じ結果になります。Job tokenはRunの作成者の実効roleで判定します。
- 直接付与を外しても、group bindingのroleは残ります。メンバー一覧の`directRole`と`groups`で、どこから付いたroleかを確認できます。
- 全体管理者はbrowser sessionならどのProjectもadminとして操作できます。API tokenでは全体管理者でもProject roleが必要です。
- Projectには、直接付与のadminかadminのgroup bindingが常に1つ以上必要です。最後の1つを外す・下げる操作は409になります。adminのgroup bindingは、そのgroupに入っている人がまだいなくても数えます（そのgroupの人は次のloginで反映されます）。

### Authentik側のgroupの運用

- ProjectごとにAuthentikのgroupを作り（例: `mmt-proj-asr-editors`）、Projectの設定でそのgroupにroleを付けます。group名は大文字小文字・空白も含めて完全一致です。
- ID tokenの`groups`はすべて`user_groups`へ保存するので、bindingに使うgroupを`OIDC_ALLOWED_GROUPS`に入れる必要はありません。ただし、そのgroupの人も許可groupのどれかに入っていないとloginできません。
- groupの所属はloginとsessionの再確認（既定60秒ごと）で`user_groups`へ同期します。Authentikでgroupに入れた人は、使用中のsessionでも1分ほどで権限が付きます。外した人は1分ほどで権限が外れ、そのgroupの権限だけで使っていたProject限定API tokenも401になります（tokenは失効させないので、groupに戻せば再び使えます）。ブラウザを使わずAPI tokenだけを使っている人は、次の同期まで元のgroupのままです（同期が7日より古いtokenは止まります。上の「SSOユーザーのAPI tokenの同期期限」）。すぐ止めたい場合はProjectの設定で直接付与・bindingを外すか、tokenを失効させます。
- 「プロジェクト設定」のgroup候補（`GET /auth/groups`）には、一度でも誰かのloginで同期されたgroup名だけが出ます。まだ誰もloginしていないgroupは名前を直接入力します。

## Artifacts

ファイルシステムは`ARTIFACT_FILESYSTEM_ROOT`配下に、API serverだけが読める権限で保存します。サーバー生成IDを保存キーにし、利用者のファイル名は表示用metadataとして扱います。API server間で共有する場合は同じ永続volumeが必要です。

S3は`S3_BUCKET`を設定するとProjectの保存先に選べます。`S3_ENDPOINT`未指定ならAWS S3です。互換サービスでは`S3_ENDPOINT`と必要に応じて`S3_FORCE_PATH_STYLE=true`を設定します。AWS SDKの標準credential provider、または対になった`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`を使います。必要権限は対象prefix内のPut/Get/Delete、multipart uploadとabortです。

S3では、upload中に送信元が失敗するとmultipart uploadを中断しますが、中断の完了を待たずに失敗を返します。その間にAPIが止まるとpartが残るため、実bucketにはAbortIncompleteMultipartUploadのlifecycle ruleを設定してください。実bucketでの保存・取得の確認手順は[検証手順](verification.md)の「実S3の保存・取得を確認する」にあります。

保存先の変更は以後のuploadに効きます。既存Artifactは保存したbackendを記録しているので、元のストレージも読み取り可能な状態にします。uploadはstreamingでSHA-256を計算し、DB登録に失敗したblobを削除します。mediaのseekはHTTP Rangeを使います。HTML/SVG等はダウンロード扱いにします。

DBとArtifactsは同時点でバックアップします。DBだけのrestoreでは重み・画像・音声を戻せません。

### uploadの上限とtimeout

- 1件の上限は`MMT_ARTIFACT_MAX_BYTES`（既定200GiB = 214748364800）です。超えるとnativeは413 `artifact_too_large`、MLflow経路は413 `RESOURCE_EXHAUSTED`を返します。Content-Length付きなら保存を始める前に、chunk転送なら超えた時点で中断し、書きかけのblobを消します。
- `MMT_UPLOAD_REQUEST_TIMEOUT_MS`（既定0 = 無効）はrequest全体の締め切りです。0以外にすると、その時間を超えるuploadは408で切れます。Nodeの既定は300000（5分）で、以前はこれが効いて5分を超える単一PUTが切れていました（2026-10-08に実測）。
- `MMT_UPLOAD_IDLE_TIMEOUT_MS`（既定120000）は、socketが無通信のまま続いたら切る時間です。download中にブラウザが読み込みを止めた場合も切れますが、ブラウザはRange付きで取り直します。
- headerの受信は常に60秒以内です（slowloris対策）。
- 前段proxyには、request全体のtimeoutを設けず、無通信のtimeoutをAPIと同じ120秒程度にし、bodyをbufferせずstreamでAPIへ渡す設定が必要です。同梱の`deploy/nginx.conf`は`client_max_body_size 0`、`proxy_request_buffering off`、`client_body_timeout 120s`、`proxy_send_timeout 120s`、`proxy_read_timeout 3600s`です。
- 開発用Web（Vite、port5182）もMLflowの`MLFLOW_TRACKING_URI`としてuploadの経路になるため、Viteのdev/preview serverのrequestTimeoutを0にしています。検証で別のAPIを指すときは`MMT_WEB_API_PROXY_TARGET`でproxy先を変えられます（既定`http://127.0.0.1:4182`）。
- `MMT_MLFLOW_MULTIPART_UPLOADS`（既定true）は、MLflow SDKのmultipart upload（`mpu/create`→partのPUT→`complete`）を受け付けるかです。falseにするとserver-infoが`multipart_uploads_enabled: false`を返し、`mpu/*`は501を返してSDKを1回のPUTへ戻します。開いているsessionは、falseにした後も登録まで進みます。
- `MMT_UPLOAD_FINALIZE_WAIT_MS`（既定100000）は、MLflowの`mpu/complete`がArtifactの検証・登録を待つ時間です。SDKの既定timeout（120秒）より短くしています。超えると503を返しますが、検証は続き、終われば一覧に出ます。数十GBのファイルを扱う環境では、SDK側の`MLFLOW_HTTP_REQUEST_TIMEOUT`と合わせて大きくします。
- `MMT_MLFLOW_MULTIPART_DOWNLOADS`（既定false）は変えないでください。presigned URLでの取得は作っていないので、trueにするとMLflow 3.17以降のSDKのdownloadが失敗します。
- MLflowのpartのURLは、リクエストのHostと`X-Forwarded-Proto`から組み立てます。前段proxyは`Host`を書き換えず、TLSを終端するなら`X-Forwarded-Proto`を渡してください（同梱の`deploy/nginx.conf`はどちらも設定済み）。

### 配信

- `GET /projects/:p/artifacts/:a/content`は`ETag: "sha256-<hex>"`と`Cache-Control: private, max-age=31536000, immutable`を返します。`If-None-Match`が一致すれば304、`If-Range`が一致しなければRangeを無視して200です。MLflow経路のdownloadはpathの付け替えがあるため`no-store`のままです（ETagは同じ形式）。
- upload時のContent-Typeが空か`application/octet-stream`なら、拡張子からMIMEを推定します（wav、flac、mp3、ogg、opus、m4a、aac、webm、mp4、mov、png、jpg、webp、avif、gif、csv、tsv、jsonl、txt、npy、parquet）。HTML・SVG・XML・JSは推定しません。既存のArtifactのMIMEは書き換えません。

### Artifact保存先の全体設定

- 保存先は全体管理者が `/admin/storage-backends`（画面は「全体管理」→「ストレージ」、`/settings/storage`）で追加する。種類は filesystem と S3。S3 は endpoint、region、bucket、prefix、path-style、署名（v4／v2）、TLS 検証と CA、checksum の扱い（既定 WHEN_REQUIRED）、単一PUTの part size（5MiB〜512MiB、既定8MiB）を設定する。
- 環境変数（`ARTIFACT_FILESYSTEM_ROOT`、`S3_*`）由来の `filesystem` と `s3` は従来どおり使え、画面では読み取り専用で表示される。DB へは写さない。
- secret を持つ S3 保存先を作るには `MMT_STORAGE_SECRET_KEY`（base64 の 32 byte）を API の環境に設定する。生成例: `openssl rand -base64 32`。値は `.env` だけに置き、worklog やチケットへ書かない。
- **鍵を変えると、保存済みの secret は復号できなくなる。** 起動時に `storage_backend_unavailable`（名前と理由だけ）がログに出て、その保存先の Artifact は 503 になる。鍵を変えたら、各 S3 保存先の secret を PATCH で入れ直す（鍵の自動ローテーションは未実装）。
- 新しい保存先は、作成後に「接続テスト」（put/get/range/delete を `mmt-connection-test/<uuid>/` で実施）で確かめてから既定にする。v2 の保存先も同じ。
- 署名 v2 は、v4 を受け付けない古い S3 互換ストレージ向け。AWS SDK は v4 しか持たないので、v2 は自前実装の署名（HMAC-SHA1）で送る。v2 では checksum を「必要なときだけ（WHEN_REQUIRED）」に固定する（WHEN_SUPPORTED との組み合わせは保存できない）。region は署名に使わない。
- multipart が動かない S3 互換ストレージでは、保存先の `multipartEnabled` を false にする。Artifact は API の一時ディレクトリ（`os.tmpdir()`）へ書いてから 1 回の PUT で送るので、1 件 5GiB まで・一時ディレクトリに同じ容量が要る。再開可能な upload（upload session、MLflow の multipart）はこの保存先では 422 `multipart_unsupported` になる。
- 既定の保存先（`/admin/storage-settings`）は新規Projectの作成フォームの初期選択だけを変える。既存Projectの保存先は「プロジェクト設定」で個別に変える。既存Artifactは保存時の保存先から読み続ける。
- 保存先をやめるときは `enabled:false` にする（既存Artifactは読めるが、新規保存は拒否）。既定のままでは無効にできないので、先に既定を切り替える。Artifact が参照している保存先の種類・bucket・endpoint・prefix・rootPath は変えられない（409）。
- DB 上の S3 保存先の実機確認: `MMT_VERIFY_S3_BACKEND=<名前> MMT_DATABASE_URL=... MMT_STORAGE_SECRET_KEY=... MMT_VERIFY_S3_CONFIRM=write-and-delete npx tsx scripts/verify_s3_artifacts.ts`。結果は `artifacts/verification/<日付>/s3/` に値を含めずに出る。署名のバージョンは保存先の設定から使われるので、v2 の保存先もこの手順で確かめる（[検証手順](verification.md) の「実S3の保存・取得を確認する」）。
- API プロセスが複数ある構成では、設定変更は変更を受けたプロセスで即時に効き、他のプロセスは未知の保存先名を読んだときに読み直す。有効/無効や part size の変更を全プロセスへ確実に反映するには API を再起動する。

### Artifactの削除と回収（garbage collection）

- 削除できるのは Project admin だけ（Web は Run の Artifacts で開いたファイルの「⋯」メニュー → 確認、API は `DELETE /projects/:p/artifacts/:a`、MLflow SDK は `delete_artifacts`）。editor 以下は 403。登録モデルバージョン・CodeVersion・DatasetVersion・保持中の checkpoint（`retained=true` か再開元）から参照されている Artifact は 409 `artifact_in_use` で消せない。参照元を確かめて、不要なら参照元の側を先に片付ける。
- 削除は即時に一覧・取得から消えるが、blob は `MMT_ARTIFACT_DELETE_GRACE_DAYS`（既定 7 日）残る。誤削除に気付いたら猶予中に blob を退避できる（DB の行は残るので `artifacts.storage_key` と `artifact_deletions` で場所が分かる）。画面からの復元はない。
- 回収は API プロセス内の `ArtifactGarbageCollector` が 10 分ごとに行う。同じ周回で、upload session の期限切れ処理、session の無い 7 日以上前の未完了 multipart upload の abort、24 時間更新の無い filesystem の書きかけ staging（`.upload`・`.tmp`）の削除も行う（以前の `ArtifactUploadSweeper` の周期処理はこの中に入った）。API を複数動かす場合は全プロセスで動くが、同じ blob の二重削除は成功扱いなので害は無い。
- blob を消せなかったときは `{"event":"artifact_blob_removal_failed","artifactId":…,"name":…}` がログに出て、`artifact_deletions.removal_attempts` と `last_removal_error`（エラー名だけ）が増える。次の周回で再試行する。続く場合は保存先の Delete 権限と疎通、無効化・削除した保存先でないかを確かめる。未回収の一覧: `SELECT artifact_id,removal_attempts,last_removal_error FROM artifact_deletions WHERE blob_removed_at IS NULL`。
- S3 の必要権限に DeleteObject を含める。multipart を後から無効にした保存先では、未完了 multipart upload を API から abort できないので、bucket の AbortIncompleteMultipartUpload の lifecycle rule に任せる。
- プロジェクト設定の「Artifactの使用量」（`GET /projects/:p/artifact-usage`）に、保存先ごとの件数・容量、削除待ち、参照されていない古いバージョンの量が出る。古いバージョンは自動では消さない（decisions.md）。消すなら Project admin が個別に削除する。

### Projectのアーカイブと完全な削除

- 作成: 画面ではプロジェクト切替（サイドバー上部、狭い画面では上部バーの下）の一番下の「＋ プロジェクトを作成」か、全体管理 → プロジェクトの「プロジェクトを作成」。無効化されていない人なら誰でも作れる。プロジェクト設定からは作れない。
- 公開範囲: 新しいProjectの既定は public（有効な人のユーザー全員が editor として使える。admin はメンバーだけ）。migration 054 より前からある Project は private のまま。Service Account と launcher には public の権限は付かない。
- アーカイブ（Project admin。Web はプロジェクト設定の最下部か、全体管理 → プロジェクトの行。API は `POST /projects/:p/archive`）は Project を一覧・API から隠すだけで、データは残る。待機中・実行中の Job があると 409 `project_has_active_jobs` なので、先に Job を止める。アーカイブ中は Project 限定の API token（worker・Service Account を含む）が 401 になり、Sweep の scheduler・webhook のフック・自動実行・自動昇格も止まる（全体管理者が所有者でも）。全体管理 → プロジェクトの「元に戻す」（`POST /admin/projects/:p/restore`）で戻る。
- 完全な削除（全体管理者。アーカイブ済みだけ。`DELETE /admin/projects/:p`）は元に戻せない。DB の行は 1 つの transaction で消え、Artifact の blob は `purged_project_blobs` に移って、上の garbage collector が `MMT_ARTIFACT_DELETE_GRACE_DAYS` の後に消す。猶予中なら `SELECT backend,storage_key FROM purged_project_blobs WHERE project_id=$1 AND removed_at IS NULL` で場所が分かるので退避できる。消せなかった blob は `{"event":"artifact_blob_removal_failed","purgedProjectBlobId":…,"name":…}` がログに出て、`removal_attempts` と `last_removal_error` が増え、次の周回で再試行する。
- 完全な削除の後も残るもの: `projects` の行（名前だけの墓標）、監査ログ、失効させた API token、無効化した Service Account。site のコンピュータに置いた Dataset のキャッシュなど、API の外にあるものは消えない。
- Run・metrics が多い Project では削除の transaction が長くなる（行数に比例）。利用の少ない時間に行う。

### 保存先のディレクトリ候補

- 全体管理 → ストレージで filesystem の保存先のルートディレクトリを入力すると、API サーバー上のディレクトリが候補に出る（`GET /admin/storage-directories?path=`、全体管理者だけ）。候補は API のプロセスから見えるもの（コンテナで動かすならコンテナ内のパス）。相対パスは API の作業ディレクトリが基準。読めないディレクトリは候補が空になるだけで、エラーにはならない。

### 音声Artifactのmedia情報

- WAV（`audio/wav`・`audio/x-wav`・`audio/wave`）と FLAC（`audio/flac`・`audio/x-flac`）の Artifact は、登録時に保存先から先頭 64KiB を Range で読み、長さ・sample rate・チャンネル数・bit 数・codec を `artifact_media_info` に保存する（migration 029）。ffmpeg などの追加依存は無い。
- 読み込みや解析に失敗しても Artifact の登録は成功する。API ログに `{"event":"artifact_media_info_failed","artifactId":…,"projectId":…,"name":…}` が出る。保存先の場所や SQL の詳細は出さない。多発する場合は、保存先の Range 読み込み（S3 の GetObject Range、filesystem の読み取り権限）を確認する。
- この機能より前に登録した Artifact には media 情報が無い（API は 404、Web は decode 後の値だけを表示）。必要になったら、`mime_type` が上記で `artifact_media_info` に行の無い Artifact を対象に、同じ `recordArtifactMediaInfo` を呼ぶ一括処理を後から足す（今回は作っていない）。
- MP3・Ogg・m4a などは下の「長い音声・動画のpreview worker」の ffprobe が後から media 情報を足す（`source='ffprobe'`）。

### 長い音声・動画のpreview worker

64MiBを超える音声、ヘッダーでmedia情報を読めない音声（mp3、m4a、ogg、opusなど）、動画について、波形・スペクトログラム・posterをAPIとは別のpreview workerが作ります。API imageにはffmpegを入れません。

- compose: `docker compose up -d preview`（`Dockerfile.preview`、ffmpeg入り）。DBとArtifact保存先（`artifacts` volume、S3の環境変数）をAPIと共有します。DB由来の保存先を使う場合は`MMT_STORAGE_SECRET_KEY`をAPIと同じ値で`.env`に入れます。
- compose以外: ffmpeg/ffprobeを入れたホストで`npm run preview-worker -w @mmt/api`。systemdで動かす場合もAPIと同じ`.env`を読みます。
- 設定: `MMT_PREVIEW_FFMPEG_PATH`／`MMT_PREVIEW_FFPROBE_PATH`（既定`ffmpeg`／`ffprobe`）、`MMT_PREVIEW_POLL_INTERVAL_MS`（既定5000）、`MMT_PREVIEW_TOOL_TIMEOUT_MS`（1回のffprobe/ffmpegの上限。既定30分、最大40分）、`MMT_PREVIEW_WORK_DIR`（本体を一時的に置く場所。最大のArtifactが入る空きが要る。既定はOSの一時ディレクトリ、composeでは`preview-work` volume）。
- 複数台を同時に動かせます（`FOR UPDATE SKIP LOCKED`）。停止（SIGTERM）は処理中のArtifactを終えてから抜けます。composeの`stop_grace_period`は30秒なので、長い処理の途中で止めた行は2時間後に別のworkerが引き継ぎます。
- 状態の確認: `SELECT kind,status,error,count(*) FROM artifact_previews GROUP BY 1,2,3;`。`ffmpeg_unavailable`が増えたらworkerのffmpegを確認します。`failed`の`storage_failed`・`source_unreadable`は保存先の障害、`probe_failed`・`render_failed`はファイル側の問題です。
- ログ: `artifact_preview_worker_started`、`artifact_preview_worker_failed`、`artifact_preview_source_unreadable`、`artifact_preview_store_failed`、`artifact_preview_enqueue_failed`（API側）。ffmpegの出力と保存先のパスは出しません。
- 生成物は`.previews/<元のArtifact ID>/`のRunの無いArtifactとして、Projectの現在の保存先に入ります。この機能より前のArtifactは対象外です（backfillは未実装）。

## SSH/GPU worker

workerはAPI serverとは別processです。SSH秘密鍵とknown_hostsはworkerのfilesystemに置き、ComputeTargetにはパスだけ登録します。known_hostsの確認を無効にしません。接続先のPythonとvenv/pip、コードが必要とするCUDA/driverは実行先に用意してください。鍵・tokenをCodeVersion.environmentへ書かないでください。

workerにはProject限定のService Account tokenを渡します。`read`、`worker:execute`、コードsnapshotを保存する`artifacts:write`を付けます。実行中コードのSDKが記録する場合は`runs:write`、モデルやデータセットを登録する場合は`registry:write`も必要です。詳細は[worker手順](worker.md)を参照してください。

GPU予約はこのアプリ内のJob間で排他にします。ほかのSSH shellや別schedulerが同じGPUを使うことまでは防げません。共有GPUではアプリ専用のGPU一覧・作業directoryを設定してください。

worker identityとstate directoryは再起動後も保持します。APIやSSHの応答が失われても、実行状態を確認するまで同じJobを二重起動しません。状態未確認のJobのGPUを自動解放しません。停止要求後はworkerから終了が報告されてから再実行します。

## workerホストへworkerを導入する

APIサーバーはworkerホストへSSHしない（decisions.md）。導入・更新・状態確認は、workerホスト上で `mado-tracking-worker` CLI を使う。常駐はsystemdが正、Docker composeは補助。

### 1. tokenを用意する

workerのtokenは、人に紐付かないService Accountで発行する。発行した人がProjectを離れても止まらない。

1. 「プロジェクト設定」の「Service Accounts」で「Service Accountを作成」を押す。名前（例: `gpu-host-1-worker`）、説明、Role `Admin` を入力する。`worker:execute` scope は Role が Admin の Service Account にだけ発行できる。
2. 作成した行の「tokenを発行」を押し、scope `read`・`worker:execute`・`artifacts:write`（出力の登録をするなら `registry:write` も。`result.json` version 2で出力（モデル・データセット）を宣言するJobは `registry:write` が無いとfailedになる）、有効期限（上限365日、`MMT_TOKEN_MAX_LIFETIME_DAYS`）を選ぶ。
3. 表示されたtokenを次の手順の入力に使う。tokenは一度だけ表示される。

APIで行う場合（Project adminのbrowser sessionが必要。API tokenからは403 `session_required`）:
- `POST /api/projects/:p/service-accounts` `{name, description, role:'admin'}`
- `POST /api/projects/:p/service-accounts/:id/tokens` `{name, scopes:['read','worker:execute','artifacts:write'], expiresAt?}`

確認: `mado-tracking-worker doctor` が `GET /api/auth/token` で scope を表示する。「プロジェクト設定」の「Projectのtoken一覧」に、所有者 Service Account・先頭12文字・最終使用（5分ごとに更新）が出る。

止めるとき: Service Accountを「無効化」すると、そのtokenは次の要求から401になる。1本だけ止めるときは「Projectのtoken一覧」で失効する。期限が近づいたら新しいtokenを発行し、`mado-tracking-worker install --token-file` で差し替える。

既存の個人所有のservice token（一覧で「旧形式」）は動き続けるが、所有者がProjectを離れると止まる。稼働中Playgroundの旧形式tokenは期限（2026-10-15）までにService Accountのtokenへ置き換える。

### 2. venvへ入れてinstallする（user unit）

```bash
python3 -m venv ~/.local/share/mado-tracking-worker/venv
~/.local/share/mado-tracking-worker/venv/bin/pip install 'mado-tracking[telemetry]'   # 社内配布先かwheelのpath
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker install \
  --api-url https://tracking.example.internal \
  --worker-id gpu-host-1 \
  --target-ids "<target-uuid>"
# tokenは端末なら非表示の入力、パイプなら標準入力、または --token-file で渡す。引数には書かない
loginctl enable-linger "$USER"   # ログアウト後も動かす場合
```

installがすること:
- `~/.config/mado-tracking-worker/<worker-id>.env` を mode 600 で書く（API URL、worker ID、target、state directory、token）。
- `~/.config/systemd/user/mado-tracking-worker@.service` を書き、`systemctl --user daemon-reload` → `enable --now mado-tracking-worker@<worker-id>.service`。
- state directoryの既定は、手で起動していたworkerと同じ `~/.local/state/mado-tracking-worker/<sha256(worker-id)の先頭16桁>`。手動起動から移るときも実行中Jobのjournalを引き継ぐ。別の場所なら `--state-dir`。
- worker IDは英数字・`.`・`_`・`-`の64文字まで（systemdのinstance名とファイル名に使うため）。
- `--target-ids`（env fileの`MMT_WORKER_TARGET_IDS`）は省略できるが、全体設定の「コンピュータ」の「接続を確認」（target checks）をclaimするのは`MMT_WORKER_TARGET_IDS`にそのtargetを含むworkerだけ。未設定のworkerは確認をclaimしない（[worker手順](worker.md)の「Compute targetの接続を確認する」）。

system unitにする場合は root で `--systemd-system --service-user <account>`。env fileは `/etc/mado-tracking-worker/<id>.env`（root、600）、stateは `/var/lib/mado-tracking-worker/<id>`（service userの所有、700）。手で置く場合の雛形は `deploy/worker/mado-tracking-worker@.service` と `deploy/worker/worker.env.example`。

unitは `Restart=on-failure`、`KillMode=process`。worker自身の再起動・停止・upgradeでは、detachされた実行中Jobを止めない（再起動後のworkerがjournalから回収する）。Jobを止めるのはcancel APIだけ。

### 3. 確かめる

```bash
mado-tracking-worker doctor --worker-id gpu-host-1 [--ssh-key <targetのsshKeyPath>] [--known-hosts <knownHostsPath>]
mado-tracking-worker status --worker-id gpu-host-1     # unit状態、worker lock、保持中Job。止まっていれば終了コード3
journalctl --user -u mado-tracking-worker@gpu-host-1 -f
```

doctorは、env fileとstate directoryのmode、APIへの到達（`/api/health`）、tokenのscope（`GET /api/auth/token`。Job tokenは不可）、`~/.ssh`・秘密鍵（group/otherの権限なし）・known_hosts（group/other書き込み不可）を確かめる。errorがあれば終了コード1。Compute画面の「Workers」にバージョンとホスト名が出ることも確認する。

### 4. 更新する

```bash
mado-tracking-worker upgrade --worker-id gpu-host-1 --version 0.2.0
# 配布先がPyPI形式でなければ --package-spec /path/to/mado_tracking-0.2.0-py3-none-any.whl
```

unitのExecStartにあるvenvへ `pip install --upgrade` してから `systemctl restart`。実行中Jobとjournalはそのまま。unitが止まっているのに別のworkerがstate directoryのlockを持っている（手で起動したworkerが残っている）場合は、何もせず止まる。pipが失敗したら再起動しない。

### Docker composeで動かす（補助）

SSH targetだけを使うworkerは `docker compose --profile worker up -d worker` でも動かせる。
- token: `MMT_WORKER_TOKEN_FILE`（既定 `./var/worker-token`）をDocker secretとして `/run/secrets/mmt_worker_token` に渡す。
- 鍵とknown_hosts: `MMT_WORKER_SSH_DIR`（既定 `./var/worker-ssh`）を `/home/worker/.ssh` にread-onlyでmountする。targetの `sshKeyPath`・`knownHostsPath` はcontainer内のpathで登録する。鍵の所有者に合わせて `MMT_WORKER_UID`/`MMT_WORKER_GID` でbuildする。
- state: volume `worker-state`。消すと実行中Jobを回収できなくなる。
- `MMT_WORKER_ID`（既定 `compose-worker-1`）、`MMT_WORKER_API_URL`（既定 `http://api:4182`）、`MMT_WORKER_TARGET_IDS`。
- local executorのJobはcontainerと一緒に止まるため、composeでは使わない。
- 確認は `docker compose --profile worker run --rm worker doctor`。

## 外部のコンピュータ（site）とフック

siteの考え方と手順は[sites.md](sites.md)、フックは[hooks.md](hooks.md)。ここではサーバー側で用意するものをまとめる。

- launcher: 「全体管理」→「ランチャー」（`/settings/launchers`）で登録してtokenを発行し、`docker compose --profile launcher up -d launcher`で動かす。起動設定（`launcher.toml`。APIのURL・tokenファイル・状態の置き場）は`MMT_LAUNCHER_CONFIG_DIR`、tokenファイル（mode 600）は`MMT_LAUNCHER_SECRETS_DIR`にread-onlyでmountする。担当のコンピュータの設定・job shell・鍵の依頼は巡回のたびにAPIから読む。launcherが作った鍵（秘密鍵）、known_hosts、投入の記録はvolume `launcher-state`（消すと、届かなかった報告を送り直せず、鍵も作り直しになり公開鍵を登録し直す）。設定の書き方は[deploy/sites](../deploy/sites/README.md)。tokenが漏れたら「全体管理」→「ランチャー」の「tokenを作り直す」で古いtokenを止める。
- runner用の公開hostname: LANの外の計算ノードが報告するhostnameは、画面やSSOと分けて、Job tokenの要求と署名付きwebhookだけを通す（[deploy/edge](../deploy/edge/README.md)）。
- Forgejo（ジョブのgit repoとcontainer registry）: `docker compose --profile forge up -d forgejo`。`SECRET_KEY`は先に作ったファイル（`MMT_FORGEJO_SECRET_KEY_FILE`）から読む。鍵が無いとForgejoは公開されている既定値を使うので、必ず作り、backupにも含める（[deploy/forgejo](../deploy/forgejo/README.md)）。公式のbase imageは[images/base](../images/base/README.md)。
- `MMT_HOOK_SECRET_KEY`（base64の32 byte、`openssl rand -base64 32`）: webhookのフックのsecretを暗号化する。無いとwebhookのフックを作れない。鍵を替えると、それまでのwebhookのフックは503 `hook_secret_key_missing`になるので、作り直して送り手のsecretも替える。
- `MMT_IMAGE_PLATFORM_CHECK=enforce`: dockerのimageがtargetの`cpuArch`向けかをregistryで確かめてからJobを保存する。registryに届かないと503で保存できないので、registryの止まる時間帯がある環境では`off`（既定）のままにする。非公開のimageには`MMT_REGISTRY_USERNAME`・`MMT_REGISTRY_PASSWORD`（読み取りだけの利用者）を置く。
- API serverの中で、siteのJobの期限（待ち行列の上限、15分届かない投入の結果）を30秒ごと、フックの待ちの期限（7日）と終わったarrayを10分ごとに確かめる。複数のAPI processがあっても1つだけが動く。別に動かすprocessは無い。

## Run終端の後処理が失敗したとき

Runが終端（finished/failed/canceled）になったときの後処理（出力モデルの登録、保留中の自動実行など。handlerは今後追加します）は、handlerごとにSAVEPOINTを張って実行します。handlerが例外を出すと、そのhandlerの変更だけを戻し、Run/Jobの終端とGPU予約の解放は確定し、後続のhandlerも実行します。

失敗はAPIの標準エラー出力に1行のJSONで出ます。

```json
{"event":"run_completion_handler_failed","handler":"<handler名>","runId":"<Run ID>","message":"<例外のmessage>"}
```

この行が出たら、そのRunの後処理（登録記録・自動実行の記録など）が欠けていないかを確認してください。自動では再実行しません。失敗を記録として残す必要があるhandler（出力登録、昇格判定）は、各handlerが自分の表に残します。

MLflowのRunは終端から`RUNNING`へ戻して再び終端にできるため、同じRunでhandlerが2回以上呼ばれることがあります。handlerは二重に処理しないように作ります。

plugin outboxへのイベント投入はhandlerではありません。状態が変わるたび（run.startedを含む）と、終端Runへの出力・Dataset追加の再送で積まれ、失敗するとRunの変更ごと戻ります。終端への遷移はRunを`FOR UPDATE`でlockするので、同じRunへの出力モデル登録と直列になり、終端イベントの`run.outputModelVersionIds`には確定済みのバージョンが入ります。

## 通知（Slack・Webhook・メール）

Runの失敗などを外部へ知らせます。通知先（channel）は全体管理者が登録し、どのイベントをどの通知先へ送るか（rule）は各ProjectのProject adminが「プロジェクト設定」の「通知」で決めます。

### 通知先の環境変数を置く

Webhookの URL と署名の鍵はDBにも画面にも保存しません。API serverの環境変数に値を置き、通知先には変数名だけを登録します（pluginの`tokenEnv`と同じ方針）。変数名は`MMT_NOTIFICATION_`で始まる英大文字・数字・`_`に限ります。ほかの設定（DBのURLなど）を通知先に指定できないようにするためです。

```sh
# API serverの.env（値はリポジトリやチャットに貼らない）
MMT_NOTIFICATION_SLACK_URL=https://hooks.slack.com/services/…
MMT_NOTIFICATION_OPS_URL=https://ops.example.com/hooks/mmt
MMT_NOTIFICATION_OPS_SECRET=<openssl rand -hex 32 などで作った鍵>
```

環境変数を変えたらAPIを再起動します。「プロジェクト設定」の通知先一覧の「送信設定」が「未設定」なら、APIのプロセスにその変数が見えていません（メールは「未設定（SMTPの送信設定が無い）」）。全体管理者は「テスト送信」で、outboxを通さずにその場で1件送って結果のcodeを確かめられます。

| 種類 | 必要な設定 | 送る内容 |
|---|---|---|
| Slack（Incoming Webhook） | `urlEnv` | `text`（通知のfallback）と`blocks`（タイトル、Project、Run、実験、種別・状態、エラーの先頭500文字） |
| Webhook（署名付き） | `urlEnv`、`secretEnv` | NotificationEventのJSON。headerに`X-MMT-Event`、`X-MMT-Event-Id`、`X-MMT-Delivery`、`X-MMT-Signature: sha256=<HMAC-SHA256(鍵, 本文)>` |
| メール | `recipients`（1〜50件、表示名なしのアドレス） | 件名`[<Project名>] <タイトル>`、本文はSlackと同じ項目のplain text（エラーの先頭2000文字）。headerに`X-MMT-Event`、`X-MMT-Event-Id`、`X-MMT-Delivery`。API serverにSMTPの設定が無ければ送らず、送信履歴に`email_sender_unavailable`の失敗として残る |

受信側は`X-MMT-Signature`を本文そのままのbyte列で検証し、`X-MMT-Event-Id`（同じイベントは全ruleで同じID）で重複を除いてください。本文にexecution snapshot、parameters、環境変数、tokenは入れません。

送信は5秒で打ち切り、redirectは追いません（3xxは`notification_redirect_refused`）。URLは`http`/`https`だけで、user・passwordを含むURLは送りません。

### メール（SMTP）を有効にする

メールはAPI serverに次の2つがあるときだけ送ります。無ければメールの通知先は作成・ruleへの登録はできますが、送信は`email_sender_unavailable`で失敗します（再試行しません）。

```sh
# API serverの.env（URLにパスワードを含むので、値はリポジトリやチャットに貼らない）
MMT_SMTP_URL=smtps://<user>:<password>@smtp.example.com:465   # STARTTLSなら smtp://…:587
MMT_SMTP_FROM=mado ML Tracking <mmt@example.com>
```

- `smtp://`はサーバーがSTARTTLSを提示すれば使い、`smtps://`は最初からTLSで接続します。userとpasswordに記号を含むならURLエンコードします。URLのquery（`?…`）は受け付けません（TLSの検証を外す指定を入れられないようにするため）。
- 片方だけの設定、`smtp`/`smtps`以外のURL、アドレスでない`MMT_SMTP_FROM`はAPIの起動を止めます。エラーには変数名だけを出し、値は出しません。
- TLSの証明書は常に検証します。社内CAの証明書を使うSMTPサーバーなら、API serverの`NODE_EXTRA_CA_CERTS`にCAのPEMを指定します。
- 接続・応答待ちと1通の送信全体は10秒で打ち切ります（HTTPの通知より長いのは、SMTPは挨拶・EHLO・STARTTLS・AUTH・宛先・本文と往復が多く、中継サーバーが挨拶をわざと遅らせることがあるため）。
- 失敗のcodeは`notification_timeout`、`notification_smtp_auth_failed`（認証失敗）、`notification_smtp_tls_failed`（STARTTLSの失敗）、`notification_smtp_recipients_rejected`（全宛先を拒否された）、`notification_smtp_<応答code>`、`notification_destination_unavailable`（接続できない、証明書の検証に失敗した）です。SMTPの応答文は残しません。
- 設定を入れたら、「プロジェクト設定」の通知先で「テスト送信」して届くことを確かめます。

### 送信の流れと失敗の扱い

- Runが`failed`・`canceled`・（ruleで選べば）`finished`になると、終端と同じtransactionで通知outbox（`notification_outbox`）へruleごとに1件積みます。終端がrollbackされれば通知も残りません。同じRunの同じ種別は1回だけです（completeの再送、MLflowで再開して同じ状態で終わった場合も増えません）。
- 積むのは、有効なruleで、通知先も有効で、filter（実行種別・実験・自動実行のRunだけ）に合うものだけです。
- API内のdispatcherが1秒ごとに取り出して送ります。失敗すると5秒から倍々（上限1時間）で待って再送し、8回（`NOTIFICATION_MAX_ATTEMPTS`。約10分）失敗すると`failed`にします。古い通知を送り続けても意味が薄いためです。送信中のまま60秒を過ぎた行（APIが送信中に止まった場合）は、次のdispatcherが引き取ります。
- 積んだ後で通知先やruleを無効にした行は、送らずに`failed`（`notification_channel_disabled`／`notification_rule_disabled`）にします。有効に戻しても古い通知はまとめて届きません。
- Project adminは「プロジェクト設定」の「直近の送信履歴」（`GET /api/projects/:p/notification-deliveries`）で状態・試行回数・失敗のcodeを確認できます。codeは`notification_http_<status>`、`notification_timeout`、`notification_destination_unavailable`、`notification_channel_unconfigured`（環境変数が無い）、`notification_url_invalid`などで、送信先のURLや応答本文は残しません。メールのcodeは上の「メール（SMTP）を有効にする」を参照。
- 通知先の作成・変更・テスト送信、ruleの作成・有効切替は監査ログ（`notification.channel.create`／`update`／`test`、`notification.rule.create`／`update`）に残ります。環境変数の値と宛先のメールアドレスは記録しません（宛先は件数だけ）。

## 運用監視（heartbeat途絶・worker停止・plugin送信滞留）

API serverは30秒ごとに次を確かめ、見つけたらProjectの「運用アラート」（ヘッダのベル）に出し、通知ruleで選んだ通知先へ送ります。複数のAPI processを動かしても判定は1つだけが行います。

| 種別 | 条件 | 閉じる条件 |
|---|---|---|
| Jobのheartbeat途絶（`job.heartbeat_stale`） | claimed/runningのJobのheartbeatが60秒より古い | heartbeatが戻る（`job.heartbeat_recovered`を通知）／Jobが終わる |
| workerの停止（`worker.offline`） | workerの最終応答が120秒より古い | workerが再びclaim・heartbeatする／tokenの失効・期限切れ／7日以上応答なし（引退扱い） |
| Plugin送信の滞留（`plugin.delivery_stalled`） | 有効なpluginの未送信eventのうち最古が15分より古い、または1件でも5回以上試行した | 未送信が条件を下回る／pluginを無効にする |

- 通知はアラートを開いたときに1回だけ（Jobは復旧時にも1回）。同じ対象が再び途絶したら、新しいアラートとして再び通知します。
- 通知を受けるには、Project設定の「通知」でruleを作り、上の種別を選びます。worker・pluginの通知は、Runの条件（実行種別・実験）を付けたruleには届きません。
- Jobは途絶しても失敗にしません（workerがまだ処理を続けている可能性があるため）。止まったJobはJobs画面から停止を要求するか、workerホストを確認します。
- Pluginの送信状況はPlugins画面の「イベントの送信状況」（Project admin）で見られます。pluginを直したら「イベントを再送」で待ち時間を飛ばして再送します。
- 閾値はコードの定数（`apps/api/src/domain/workerLiveness.ts`、`apps/api/src/domain/operationsAlerts.ts`）で、環境変数では変えません。

## API serverの上限と保持数

| 変数 | 既定 | 意味 |
|---|---|---|
| `MMT_TOKEN_MAX_LIFETIME_DAYS` | `365` | 新しいAPI tokenの期限の上限。期限を省略したtokenはこの日数で切れる。1〜3650 |
| `MMT_REPORT_SNAPSHOT_MAX_BYTES` | `52428800` | 共有レポートの1つのバージョンで「作成時点で固定」したブロックの固定データ（JSONのUTF-8）の合計の上限（バイト）。超える保存は413 `report_snapshot_too_large` でバージョンを作らない。1ブロックは別に5MiB（`REPORT_SNAPSHOT_BLOCK_MAX_BYTES`、定数）まで。正の整数 |
| `MMT_CSV_EXPORT_MAX_ROWS` | `50000` | `POST /projects/:p/runs/search/export.csv`の最大行数。超えた分は省き、応答ヘッダ`X-MMT-Export-Truncated: true`とCSV末尾の`# truncated: ...`行で示す。正の整数 |
| `MMT_CHECKPOINT_KEEP_COUNT` | `5` | Runごとに既定の一覧へ出すcheckpointの数（1以上）。超えた古いcheckpointは`retained=false`になり、一覧の既定表示から外れる。Artifactは消さないので再開には使える |
| `MMT_ARTIFACT_DELETE_GRACE_DAYS` | `7` | 削除したArtifactのblobをgarbage collectorが保存先から消すまでの日数。0〜3650（0は次の周回で消す） |

### Run検索のCSV出力

- 検索のCSV出力は、列と件数を決めるため一致したRunを1回読み（500件ずつ、ページごとに短いtransaction）、その後に本文をstreamでもう1回読みます。50000行では検索を約200ページ読むことになります。ページの間はDB接続を保持しないので、遅いダウンロードでpoolを占有しません。
- CSVはUTF-8 BOM付きです（Excel向け）。BOMを外す場合は`apps/api/src/domain/csvEncoding.ts`の`CSV_BYTE_ORDER_MARK`を空文字にします。

### 学習の途中再開（checkpoint）

- 再開は手動だけです（Run詳細のCheckpointタブ、Jobsの「最新checkpointから再開」、retry APIの`checkpointId`／`resumeFromLatestCheckpoint`）。学習コード側の書き方は[worker手順](worker.md)の「学習を途中から再開する（checkpoint）」にあります。
- checkpointのArtifactは`checkpoints/step-<N>.tar`（SDK）または`checkpoints/step-<N>/...`（MLflow）です。容量の掃除は「Artifactの削除と回収」のArtifact削除で行います。再開Runが参照中のcheckpoint（`runs.resume_checkpoint_id`）のArtifactは消さないでください。
- worker側の照合失敗（sha256・manifest不一致）はJobのerrorに「Checkpoint ... mismatch」などで残り、entrypointは起動していません。

## Gitのファイルをエディタへ読み込む

API serverにも`git`、`ssh`、CA証明書が必要です。`Dockerfile.api`には同梱しています。公開HTTPSリポジトリは完全なcommit hashを指定します。Webで読み込むファイル数・サイズは制限し、省略したファイルを画面に表示します。Git設定やユーザーの認証情報を自動で引き継ぎません。

SSHリポジトリを読み込む場合は、API serverに`MMT_GIT_SSH_KEY_PATH`と`MMT_GIT_KNOWN_HOSTS_PATH`を両方設定します。値はサーバー内の絶対パスで、秘密鍵はmode600、known_hostsは事前に確認したものを使います。設定がなければSSHのファイル読込は拒否します。この設定はエディタの読込用です。JobのGit取得は実行先で行うため、private repositoryの認証はその実行先にも必要です。

## Docker Compose

`compose.yml`は本番構成の雛形です。ここでは外部環境へdeployしません。`.env`に上記のOIDC/HTTPS設定と`MMT_POSTGRES_PASSWORD`を入れます。DB URLにも使うためpasswordはURLでそのまま使える十分長いhex文字列にしてください。

```bash
docker compose build
docker compose up -d postgres
docker compose run --rm api npm run db:migrate --workspace @mmt/api
docker compose up -d api web
```

Webはlocalhost:5182で待ち受けます。外側のTLS reverse proxyからこのportへ接続します。API/DBは外部portを公開しません。Artifact volumeはAPIの実行ユーザーに書き込み権限を持たせます。workerとpluginは別に起動します。

## 外部接続を確認するとき

1. Authentikで管理者と一般メンバーがloginし、管理者group・Project権限が正しく反映されることを確認します。
2. SSH targetで小さいinference Jobを実行し、指定GPU・ログ・メトリクス・停止・再実行を確認します。
3. 実際のS3 bucketで小さいuploadとRange取得を行い、prefix権限・永続化・multipart cleanupを確認します。
4. Mado pluginからNamespaceを限定したDatasetVersionを取り込み、入力と出力のlineageを送信します。
