# Webの実装規約

`apps/web`の画面を変更するときの置き場所と層の分け方です。画面の文言は`apps/web/src/i18n/`に集め、画面（`pages/`、`components/`、`layout/`）、状態管理のhook（`hooks/`）、APIクライアント（`api/`）、純粋なロジック（`lib/`）を分けます。

## スタイルシート

`apps/web/src/styles/`に領域別のファイルを置き、`apps/web/src/main.tsx`が次の順に読み込みます。

| ファイル | 対象 |
|---|---|
| breakpoints | 画面幅の切り替え点（`--bp-sm`・`--bp-md`・`--bp-lg`）とタップ領域の最小サイズ（`--tap-target`） |
| base | フォント、テーマ変数、要素の既定、文字組み、ボタン、通知・読み込み表示 |
| layout | 上部バー、ナビゲーションのドロワー、プロジェクトバー、ページ枠と見出し、タブ、ログイン画面 |
| tables | 実験サイドバー、Runのツールバー・選択バー、表、状態バッジ |
| registry | Registryの一覧・詳細、詳細リスト、自動実行パネル、グラフ、ログ、Job、Lineage |
| artifacts | Artifactの一覧・プレビュー・アップロード結果 |
| forms | ダイアログ、入力欄、ウィザード |
| workbench | コード編集、ファイルツリー、Task、実行スナップショット |
| admin | 設定のセクション、plugin検索、容量メトリクス |
| uploads | Artifactのアップロードダイアログ、ドロップ領域、進み具合、途中のアップロード |

- 新しいCSSは、そのclassが属する領域のファイルへ足します。`styles.css`のような何でも入るファイルを作り直しません。
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

画面の権限判定は`lib/permissions.ts`（`isGlobalAdmin`、`canEditProject`、`canManageProject`、`canManagePlugins`、`canManageAutomationRules`、`canManageHooks`、`canCreateProject`、`canChangeOwnPassword`）に集めます。役割名との比較（`role === 'admin'`など）をcomponentに直接書きません。判定はAPIの検査（`accessService`）に合わせた表示の出し分けで、許可の正本はAPIです。

## 画面の枠

- `layout/TopBar.tsx`: 上部バー（画面の切り替え、テーマ、ユーザー表示、ログアウト）。画面の切り替え先は`layout/navigationLinks.ts`が決め、広い幅では上部バーに並べ、狭い幅では`layout/NavigationDrawer.tsx`に入れます。ローカルアカウントの利用者は、ユーザー表示から`/account/password`（パスワード変更）を開けます。
- `layout/AppShell.tsx`: Projectの画面の枠。プロジェクトバー（`layout/ProjectBar.tsx`）はProjectの選択と自分の権限の表示だけを置き、参加しているProjectが無いときは出しません。Projectの一覧と作成は設定画面の「Projects」セクション（`components/ProjectList.tsx`）です。参加しているProjectが無いときは、作成できる人には作成の案内と「Projects」セクションを、作成できない人には管理者への依頼を表示します。
- `layout/AccountShell.tsx`: Projectに属さない、ログイン中の利用者向けの画面の枠。

## 画面幅への対応

切り替え点は`styles/breakpoints.css`の`--bp-sm`（640px）・`--bp-md`（900px）・`--bp-lg`（1200px）です。CSSの変数は`@media`の中に書けないので、メディアクエリは同じ値を範囲の書き方で`@media (width < 640px)`・`(width < 900px)`・`(width < 1200px)`と書きます。スクリプトで幅を見るときは`lib/breakpoints.ts`の`narrowerThan('md')`を`lib/useMediaQuery.ts`に渡します。`lib/breakpoints.test.ts`が、CSSの変数とTSの値の一致と、ほかの数値のメディアクエリが無いことを確かめます。幅の広いタッチ画面も対象にするときだけ、`(width < 1200px), (pointer: coarse)`のように`(pointer: coarse)`を併記できます。

- 上部バー: `--bp-lg`未満では画面の切り替えを左から出るドロワー（`layout/NavigationDrawer.tsx`）へ移します。メニューボタンは`aria-expanded`で開閉を示し、Esc、ドロワーの外側のタップ、リンクの選択で閉じます。
- プロジェクトバー: どの幅でも1行です。狭い幅ではProjectの選択欄が縮み、名前を省略します。
- タップ領域: `--bp-md`未満では、ボタン・アイコンボタン・入力欄・選択欄の高さを`--tap-target`（40px）以上にします（`base.css`）。リンクボタン・summary・チェックボックスのラベル・スライダーも広げる画面は、根元の要素に`touch-targets`のclassを付けます（`styles/touchTargets.css`）。
- 表: 狭い幅で列を減らす一覧は`components/ResponsiveTable.tsx`を使います。列ごとに`priority: 'primary' | 'secondary'`を指定し、`--bp-md`未満では`primary`の列だけを行に残して、行の右端のボタンで`secondary`の列を行の下に開きます。`selectedKey`で選択中の行に印を付け、`empty`で行が無いときの表示を渡します。テストでは幅を引数で受ける`ResponsiveTableView`を描画します。`onRowClick`はポインタ用の近道なので、キーボードで開けるリンクかボタンを`primary`の列に置きます。`components/DataTable.tsx`は表の中だけで横にスクロールします。
- ダイアログ: `components/Dialog.tsx`は`--bp-sm`未満で全画面になります。`fullScreenOnNarrow={false}`を渡すと、全画面ではなく下から出るシートになります（`ConfirmDialog`はシート）。

## 確認ダイアログ

入力欄の無い確認は`components/ConfirmDialog.tsx`を使います。`fields={[]}`の`FormDialog`で代用しません。

## Artifactのアップロード

`dialogs/ArtifactUploadDialog.tsx`が[再開可能なArtifact upload](api-contract.md#再開可能なartifact-upload)を使います。`multiple`を付けると複数ファイル・フォルダ（`webkitdirectory`とdrag&drop）を受け付け、フォルダ内の相対pathを保存先フォルダの下に置きます。付けないと1ファイルだけで、Artifactができたら呼び出し側が閉じます（コード版の登録）。

- 8MiB未満は従来の単一PUT、8MiB以上はupload sessionでpartに分けて送ります。進み具合を得るため、bodyはXMLHttpRequestで送ります（`api/artifactUploads.ts`）。
- 同時に送るrequestはキュー全体で3本（`hooks/useArtifactUploadQueue.ts`の`MAX_CONCURRENT_REQUESTS`）。partごとに最大5回まで指数backoffで再試行し、それでも失敗したファイルは「失敗」で止まります。
- 一時停止と再開はsessionを残し、再開時に`GET /artifact-uploads/:u`の受信済みpartとの差分だけを送ります。取消は`DELETE`でsessionを`aborted`にします。
- 再読込に備え、localStorageに`{uploadId, projectId, runId, path, name, size, lastModified}`を残します（`lib/uploadResumeStore.ts`。保存できない環境でも送信はできます）。同じファイルを同じ保存パスで選び直すと続きから送ります。localStorageに無いサーバー側の`open` sessionは、受信済みpartのSHA-256が選んだファイルと一致したときだけ使います。
- 送信中はダイアログを閉じられず、ページを離れるときは`beforeunload`で警告します。ダイアログはRunの取得が失敗しても消えないよう、`Resource`の外に置きます。
