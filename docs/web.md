# Webの実装規約

`apps/web`の画面を変更するときの置き場所と層の分け方です。画面の文言は`apps/web/src/i18n/`に集め、画面（`pages/`、`components/`、`layout/`）、状態管理のhook（`hooks/`）、APIクライアント（`api/`）、純粋なロジック（`lib/`）を分けます。

## スタイルシート

`apps/web/src/styles/`に領域別のファイルを置き、`apps/web/src/main.tsx`が次の順に読み込みます。

| ファイル | 対象 |
|---|---|
| base | フォント、テーマ変数、要素の既定、文字組み、ボタン、通知・読み込み表示 |
| layout | 上部バー、プロジェクトバー、ページ枠と見出し、タブ、ログイン画面 |
| tables | 実験サイドバー、Runのツールバー・選択バー、表、状態バッジ |
| registry | Registryの一覧・詳細、詳細リスト、自動実行パネル、グラフ、ログ、Job、Lineage |
| artifacts | Artifactの一覧・プレビュー・アップロード結果 |
| forms | ダイアログ、入力欄、ウィザード |
| workbench | コード編集、ファイルツリー、Task、実行スナップショット |
| admin | 設定のセクション、plugin検索、容量メトリクス |

- 新しいCSSは、そのclassが属する領域のファイルへ足します。`styles.css`のような何でも入るファイルを作り直しません。
- 画面幅による上書き（`@media`）は、対象の領域ファイルの末尾にまとめます。
- 詳細度が同じルールは読み込み順で勝ち負けが決まります。新しい領域ファイルを作るときは`main.tsx`の末尾に足し、既存の順番を入れ替えません。

## エラー文言の層

- `api/*.ts`（APIクライアント）は`i18n`を読み込みません。失敗は`RequestError`（status、code、サーバーのerror文字列`serverMessage`）で返します。`api/i18nIndependence.test.ts`がAPIクライアントのi18n importを検出します。
- 画面に出す文言への変換は`lib/errorMessage.ts`の`formatErrorMessage`が行い、`useMutation`と`useQuery`がこれを使います。それ以外のcodeはサーバーの文字列をそのまま表示します。Webが文言を持つcodeは、APIの応答本文が無い次の場合だけです。
  - `network_error`: APIへ接続できなかった
  - `invalid_response`: 応答の形が契約と違う（`invalidResponseError()`で投げる）
  - `artifact_too_large`: uploadの413。前段proxyがHTMLで拒否した場合も同じ文言にする
  - `artifact_content_unavailable`: Artifactの中身を取得できなかった（raw bytesの取得でAPIのエラー本文が無い）

## 権限判定

画面の権限判定は`lib/permissions.ts`（`isGlobalAdmin`、`canEditProject`、`canManageProject`、`canManagePlugins`、`canManageAutomationRules`、`canCreateProject`、`canChangeOwnPassword`）に集めます。役割名との比較（`role === 'admin'`など）をcomponentに直接書きません。判定はAPIの検査（`accessService`）に合わせた表示の出し分けで、許可の正本はAPIです。

## 画面の枠

- `layout/TopBar.tsx`: 上部バー（画面の切り替え、テーマ、ユーザー表示、ログアウト）。ローカルアカウントの利用者は、ユーザー表示から`/account/password`（パスワード変更）を開けます。
- `layout/AppShell.tsx`: Projectの画面の枠。プロジェクトバーはProjectの選択と自分の権限の表示だけを置きます。Projectの一覧と作成は設定画面の「Projects」セクション（`components/ProjectList.tsx`）です。参加しているProjectが無いときは、作成できる人には作成の案内と「Projects」セクションを、作成できない人には管理者への依頼を表示します。
- `layout/AccountShell.tsx`: Projectに属さない、ログイン中の利用者向けの画面の枠。

## 確認ダイアログ

入力欄の無い確認は`components/ConfirmDialog.tsx`を使います。`fields={[]}`の`FormDialog`で代用しません。
