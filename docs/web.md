# Webの実装規約

`apps/web`の画面を変更するときの置き場所と層の分け方です。画面の文言は`apps/web/src/i18n/`に集め、画面（`pages/`、`components/`、`layout/`）、状態管理のhook（`hooks/`）、APIクライアント（`api/`）、純粋なロジック（`lib/`）を分けます。

## スタイルシート

フォント、色・影・角丸・書体の変数、要素の既定、共通の部品（ボタン、入力欄、ダイアログ、タブ、表、状態バッジ、ページの見出し）、画面の枠（上部バー、サイドバー、ドロワー、ログイン画面）はMadoと共有するデザインシステム（`@mado/design-system`、[aida0710/mado-design-systems](https://github.com/aida0710/mado-design-systems)）にあり、`apps/web/src/main.tsx`が日本語のNoto Sans JPとあわせて最初に読み込みます。ファイルの分け方と決まり、バージョンの上げ方は[リポジトリのREADME](https://github.com/aida0710/mado-design-systems#readme)にあります。依存はGitHub Releaseのtarball（`apps/web/package.json`）で、バージョンを上げるときはそのURLを替えて`npm install`します。Madoも同じclass名を使うので、両方の見た目を変えるときはそのリポジトリを直してバージョンを上げ、このアプリだけの見た目は下の領域のファイルで上書きします。

そのあと、`apps/web/src/styles/`に置いた領域別のファイルを次の順に読み込みます。

| ファイル | 対象 |
|---|---|
| breakpoints | 画面幅の切り替え点（`--bp-sm`・`--bp-md`・`--bp-lg`） |
| base | このアプリの高さと幅（プロジェクトバー、Experimentsの実験一覧）、描画に失敗したときの画面 |
| layout | Projectの切り替え（サイドバーの一番上とプロジェクトバーのボタン、そのドロップダウン）、公開範囲（ProjectとコンピュータのPublic・Private）の鍵の印（`.visibility-label`）、作業領域の高さ |
| tables | Experimentsの実験一覧、Runのツールバー・選択バー、Runの表 |
| registry | Registryの一覧・詳細、詳細リスト、自動実行パネル、グラフ、ログ、Job、Lineage |
| artifacts | Artifactの一覧・プレビュー・アップロード結果 |
| forms | このアプリだけのダイアログの幅、ダイアログの中の詳細リスト、1行ずつの選択肢（`choice-picker`。保存先と公開範囲）、候補つきの入力欄 |
| workbench | コード編集、ファイルツリー、Task、実行スナップショット |
| admin | 設定のセクション（最下部のアーカイブを含む）、plugin検索、容量メトリクス、全体管理の保存先とプロジェクト一覧、ユーザーメニュー |
| uploads | Artifactのアップロードダイアログ、ドロップ領域、進み具合、途中のアップロード |
| siteComputers | 全体設定 → コンピュータのsiteの詳細（job shellのバージョン、鍵と接続確認、自分の設定、利用者の設定、手動投入の案内）とjob shellの編集欄。最後に読み込む |

- 新しいCSSは、そのclassが属する領域のファイルへ足します。`styles.css`のような何でも入るファイルを作り直しません。
- 色・影・角丸は`@mado/design-system`の変数で書き、領域のファイルに色の値を直接書きません。合う変数が無いときは、役割の名前でデザインシステムに足し、ライトとダークの両方の値を決めます。リンクなど文字に使う青緑は`--link`、選択中の印や枠は`--accent`です。
- 画面幅による上書き（`@media`）は、対象の領域ファイルの末尾にまとめます。切り替え点は下の「画面幅への対応」の3つだけを使います。
- 詳細度が同じルールは読み込み順で勝ち負けが決まります。新しい領域ファイルを作るときは`main.tsx`の末尾に足し、既存の順番を入れ替えません。

## エラー文言の層

- `api/*.ts`（APIクライアント）は`i18n`を読み込みません。失敗は`RequestError`（status、code、サーバーのerror文字列`serverMessage`）で返します。`api/i18nIndependence.test.ts`がAPIクライアントのi18n importを検出します。
- 画面に出す文言への変換は`lib/errorMessage.ts`の`formatErrorMessage`が行い、`useMutation`と`useQuery`がこれを使います。それ以外のcodeはサーバーの文字列をそのまま表示します。Webが文言を持つcodeは、APIの応答本文が無い次の場合だけです。
  - `network_error`: APIへ接続できなかった
  - `invalid_response`: 応答の形が契約と違う（`invalidResponseError()`で投げる）
  - `artifact_too_large`: uploadの413。前段proxyがHTMLで拒否した場合も同じ文言にする
  - `artifact_content_unavailable`: Artifactの中身を取得できなかった（raw bytesの取得でAPIのエラー本文が無い）

## 権限判定

画面の権限判定は`lib/permissions.ts`（`isGlobalAdmin`、`canEditProject`、`canManageProject`、`canManagePlugins`、`canManageAutomationRules`、`canManageHooks`、`canTransferHookOwners`、`canCreateProject`、`canChangeOwnPassword`、コンピュータの`canAddTarget`・`canAddSshOrLocalTarget`・`isTargetOwner`・`canManageTarget`）に集めます。役割名との比較（`role === 'admin'`など）をcomponentに直接書きません。判定はAPIの検査（`accessService`）に合わせた表示の出し分けで、許可の正本はAPIです。

## 画面の枠

- `layout/TopBar.tsx`: 上部バー（アプリ名、テーマ、ユーザー表示、ログアウト）。画面の切り替えは置きません。ユーザー表示のメニュー（`components/UserMenu.tsx`。項目は`layout/userMenuLinks.ts`）は、「アカウント」、ローカルアカウントの利用者だけ「パスワードの変更」（`/settings/account/password`）、全員に「全体設定」（`/settings/account`）です。テーマ（`hooks/useTheme.ts`）は、利用者が切り替えるまでOSの設定（`prefers-color-scheme`）に合わせ、切り替えたらブラウザの`localStorage`（`mmt.theme`）に保存します。`main.tsx`がログイン画面を含む最初の描画の前に`<html data-theme>`へ書きます。
- 画面の切り替え: 切り替え先と組（記録・モデル・データ・実行・プロジェクト管理、その下に全員の全体設定、全体管理者にはさらに全体管理）は`layout/navigationLinks.ts`の`navigationGroups`が、各画面のアイコン（lucide-react）は`layout/navigationIcons.ts`が決めます。広い幅では左のサイドバー（`layout/NavigationSidebar.tsx`）に、狭い幅では`layout/NavigationDrawer.tsx`に、組の見出しを付けて並べます。サイドバーは、名前とアイコンを並べる`sidebar`と、アイコンだけの細い列の`rail`の2つの形を持ちます。どの形にするか、畳んだかどうか、幅は`hooks/useNavigation.ts`が決めて覚えます。幅を変える境目は`layout/NavigationResizeHandle.tsx`、幅の範囲は`lib/navigationWidth.ts`です。
- `layout/AppShell.tsx`: Projectの画面の枠。`layout/ProjectBar.tsx`はProjectの切り替え（`layout/ProjectSwitcher.tsx`）と自分の権限を置き、広い幅ではサイドバーの一番上、狭い幅では上部バーの下の1行（プロジェクトバー）に出します。参加しているProjectが無いときは出しません。切り替えはブラウザのselectではなく自前のドロップダウン（listbox）で、各行に名前・公開範囲（Privateは鍵）・自分の権限を出し、開くと今のProjectを選んだ状態から↑↓・Home・End・Enter・Escで操作できます。Projectが8件以上（`lib/projectFilter.ts`の`PROJECT_FILTER_THRESHOLD`）になると絞り込みの入力を出します。一番下の「プロジェクトを作成」は作成できる人だけに出し、`dialogs/ProjectCreateDialog.tsx`を開きます。ドロップダウンはPopover API（`popover="manual"`）で最上位の層に出し、`hooks/useAnchoredPopover.ts`と`lib/dropdownPlacement.ts`が画面の内側に収めます。参加しているProjectが無いとき・開けないときは、作成できる人には「プロジェクトを作成」のボタンを、作成できない人には管理者への依頼を表示します。
- プロジェクトの作成（`dialogs/ProjectCreateDialog.tsx`）: 切り替え・全体管理のプロジェクト一覧・Projectが無いときの画面で共通の1つのダイアログです。公開範囲の既定はPublicで、Privateを選んだときだけ「メンバー（任意）」を出します。作成後は呼び出し側がそのProjectを開きます。プロジェクト設定（`pages/SettingsPage.tsx`）はそのProjectの設定だけを置き、Projectの一覧と作成はありません。最下部のアーカイブ（`components/ProjectArchiveSection.tsx`）はProject adminだけに出します。
- `layout/SettingsShell.tsx`: 全体設定（Projectに属さない画面）の枠で、誰でも開けます。項目は`/settings/<項目>`（`layout/settingsSections.ts`。`/settings`は`/settings/account`へ移る）で、サイドバーの組で切り替えます。「全体設定」の組（アカウント、コンピュータ）は全員に、「全体管理」の組（プロジェクト、ユーザー、ストレージ、ランチャー、監査ログ）は全体管理者だけに出し、プロジェクトの画面のサイドバーにも同じ組を出します。全体管理の項目を全体管理者以外が開くと（知らない項目名も）`/settings/account`へ移します（`pages/AdminPage.tsx`）。パスワードの変更（`pages/PasswordChangePage.tsx`）はアカウントの下の`/settings/account/password`で、ローカルアカウント以外は`/settings/account`へ移します。初回の必須の変更は別の`pages/RequiredPasswordChangePage.tsx`で、`AuthGate`がほかの画面の代わりに出します。各画面は`components/SettingsPageHeader.tsx`で、項目名の見出しの上に小さく属する組（「全体設定」か「全体管理」）を出します。全体設定より前のURL（`/account`、`/account/password`、`/admin`、`/admin/<項目>`）は`layout/legacySettingsPaths.ts`の対応で新しいURLへ置き換えで移します（`/admin`と知らない`/admin/<項目>`は以前と同じくプロジェクトの一覧`/settings/projects`へ）。

## コンピュータ

- 全体設定 → コンピュータ（`pages/ComputersSettingsPage.tsx`、`/settings/computers`）は誰でも開けます。一覧（`components/ComputerOverviewTable.tsx`）は`GET /targets/overview`の全コンピュータで、名前・種類・所有者（所有者のいないものは「全体」）・公開範囲（Privateは鍵）・状態（有効・無効、自動投入のsiteはランチャーの様子）・自分が使えるかを出します。使えるか管理できる行（`lib/computeTargetOverview.ts`の`canOpenTargetDetails`）だけが名前から詳細（`components/ComputerDetails.tsx`。siteは`SiteComputerDetails`、ssh・localは概要と、管理する人には接続確認）を開きます。詳細と編集の値は`GET /targets`（使える・管理するものだけ）から取り、2つの読み込みは`hooks/useComputers.ts`がまとめます。編集・有効の切り替え・接続確認は所有者と全体管理者だけです。
- 追加・編集のダイアログ（`dialogs/TargetDialog.tsx`、`components/TargetFields.tsx`）は誰でも使え、足した人が所有者になります。研究者はsiteだけ、全体管理者はExecutorを選べます。公開範囲（`components/VisibilityPicker.tsx`）の既定はPrivateで、所有者のいないコンピュータは選ばせません（APIがPrivateを拒むため）。
- プロジェクトの「Compute」（`pages/ComputePage.tsx`）は、このプロジェクトで自分が使えるコンピュータ（`GET /targets?projectId=`）の読み取りだけの一覧（`components/ComputeTargetsTable.tsx`）と、全体設定 → コンピュータへのリンク、workerの状態です。

## 画面幅への対応

切り替え点は`styles/breakpoints.css`の`--bp-sm`（640px）・`--bp-md`（900px）・`--bp-lg`（1200px）です。CSSの変数は`@media`の中に書けないので、メディアクエリは同じ値を範囲の書き方で`@media (width < 640px)`・`(width < 900px)`・`(width < 1200px)`と書きます。スクリプトで幅を見るときは`lib/breakpoints.ts`の`narrowerThan('md')`を`lib/useMediaQuery.ts`に渡します。`lib/breakpoints.test.ts`が、CSSの変数とTSの値の一致と、ほかの数値のメディアクエリが無いことを確かめます。幅の広いタッチ画面も対象にするときだけ、`(width < 1200px), (pointer: coarse)`のように`(pointer: coarse)`を併記できます。

- 画面の切り替え: `--bp-lg`以上では左のサイドバーに名前とアイコンを並べます。サイドバーの下のボタンでアイコンだけの列（幅`--navigation-rail-width`、名前はツールチップと読み上げで伝えます）に畳め、右の境目をドラッグするか、境目にフォーカスして左右の矢印キーで幅（`--navigation-width`）を160〜360pxの間で変えられます。ダブルクリックかEnterで既定の192pxに戻ります。畳んだかどうかと幅は、ブラウザの`localStorage`（`mmt.navigation.collapsed`・`mmt.navigation.width`）に保存します。`--bp-md`以上`--bp-lg`未満では、サイドバーとExperimentsの実験一覧が並ぶとRunの表の幅が足りないので、いつもアイコンだけの列にします。`--bp-md`未満では上部バーのメニューボタンから左に出るドロワー（`layout/NavigationDrawer.tsx`）へ移します。メニューボタンは`aria-expanded`で開閉を示し、Esc、ドロワーの外側のタップ、リンクの選択で閉じます。
- プロジェクトバー: サイドバーを名前つきで広げていないとき（アイコンだけの列とドロワー）に出し、どの幅でも1行です。狭い幅ではProjectの切り替えのボタンが縮み、名前を省略します。サイドバーはライト・ダークのどちらでも上部バーと同じ暗い地なので、サイドバーの中の切り替えのボタン・ラベル・権限は`--header-*`の色を使い、ドロップダウンは画面と同じ面の色にします。画面の上に並ぶものの高さは`--chrome-height`（上部バーと、出ていればプロジェクトバー）です。
- タップ領域: `--bp-md`未満では、ボタン・アイコンボタン・入力欄・選択欄の高さを`--tap-target`（40px）以上にします（パッケージの`base.css`と`components.css`）。リンクボタン・summary・チェックボックスのラベル・スライダーも広げる画面は、根元の要素に`touch-targets`のclassを付けます（`components.css`）。
- 表: 狭い幅で列を減らす一覧は`components/ResponsiveTable.tsx`を使います。列ごとに`priority: 'primary' | 'secondary'`を指定し、`--bp-md`未満では`primary`の列だけを行に残して、行の右端のボタンで`secondary`の列を行の下に開きます。`selectedKey`で選択中の行に印を付け、`empty`で行が無いときの表示を渡します。テストでは幅を引数で受ける`ResponsiveTableView`を描画します。`onRowClick`はポインタ用の近道なので、キーボードで開けるリンクかボタンを`primary`の列に置きます。`components/DataTable.tsx`は表の中だけで横にスクロールします。
- ダイアログ: `components/Dialog.tsx`は`--bp-sm`未満で全画面になります。`fullScreenOnNarrow={false}`を渡すと、全画面ではなく下から出るシートになります（`ConfirmDialog`はシート）。

## 候補つきの入力欄

`FormField`に`suggest`（入力値と`AbortSignal`を受けて候補と注記を返す関数）を渡すと、`components/FormFields.tsx`はその欄を`components/SuggestionInput.tsx`（ARIAのcombobox）で描きます。候補は入力が止まってから（`hooks/useFieldSuggestions.ts`の`FIELD_SUGGESTION_DELAY_MS`）引き、新しい入力が前の要求を中断します。↑↓で選び、EnterかTabで入れ、Escは候補だけを閉じます（周りのダイアログは閉じません）。部品は保存先のAPIを知りません。保存先のルートディレクトリの候補（`GET /admin/storage-directories`）は`dialogs/StorageBackendDialog.tsx`が渡し、無いパス・ファイルの注記は`lib/storageDirectorySuggestions.ts`が決めます。

## 確認ダイアログ

入力欄の無い確認は`components/ConfirmDialog.tsx`を使います。`fields={[]}`の`FormDialog`で代用しません。

## テキストのプレビュー

Artifactのテキストのプレビュー（`components/preview/CodeView.tsx`）は、形式に合わせて色を付けます。形式の判定と色付けは、Madoと共有する`@mado/design-system/code`（highlight.jsと、CSV・TSV・ログの色付け）にあります。対応する形式と判定の順は[デザインシステムのREADME](https://github.com/aida0710/mado-design-systems#テキストの色付け)にあります。

- 形式は、ファイル名、メディアタイプ、中身の先頭の順に決めます。どれにも当たらなければ色を付けません。
- プレビューの上の「表示形式」で形式を選び直せます。選んだ形式は拡張子ごとにブラウザの`localStorage`（`mmt.codeLanguage`）に保存し（`hooks/useCodeLanguage.ts`）、同じ拡張子のファイルを次に開いたときにも使います。「自動」に戻すと保存を消します。`.env`と`Dockerfile`は名前で覚えます。何でも入る`.txt`と、拡張子の無いほかのファイルは覚えません。
- プレビューできる大きさは1MiBまで（`TEXT_PREVIEW_MAX_BYTES`）で、色を付けるのは先頭の200,000文字までです。
- 表示は、テーマにかかわらずログと同じ暗い地（`--code-background`）です。

## Artifactのアップロード

`dialogs/ArtifactUploadDialog.tsx`が[再開可能なArtifact upload](api-contract.md#再開可能なartifact-upload)を使います。`multiple`を付けると複数ファイル・フォルダ（`webkitdirectory`とdrag&drop）を受け付け、フォルダ内の相対pathを保存先フォルダの下に置きます。付けないと1ファイルだけで、Artifactができたら呼び出し側が閉じます（コードバージョンの登録）。

- 8MiB未満は従来の単一PUT、8MiB以上はupload sessionでpartに分けて送ります。進み具合を得るため、bodyはXMLHttpRequestで送ります（`api/artifactUploads.ts`）。
- 同時に送るrequestはキュー全体で3本（`hooks/useArtifactUploadQueue.ts`の`MAX_CONCURRENT_REQUESTS`）。partごとに最大5回まで指数backoffで再試行し、それでも失敗したファイルは「失敗」で止まります。
- 一時停止と再開はsessionを残し、再開時に`GET /artifact-uploads/:u`の受信済みpartとの差分だけを送ります。取消は`DELETE`でsessionを`aborted`にします。
- 再読込に備え、localStorageに`{uploadId, projectId, runId, path, name, size, lastModified}`を残します（`lib/uploadResumeStore.ts`。保存できない環境でも送信はできます）。同じファイルを同じ保存パスで選び直すと続きから送ります。localStorageに無いサーバー側の`open` sessionは、受信済みpartのSHA-256が選んだファイルと一致したときだけ使います。
- 送信中はダイアログを閉じられず、ページを離れるときは`beforeunload`で警告します。ダイアログはRunの取得が失敗しても消えないよう、`Resource`の外に置きます。
