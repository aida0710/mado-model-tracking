# Web

React/Viteの独立UI。表示データは`/api`から取得する。API失敗時のfixtureへの切り替えはない。Viteは`/api`を`http://127.0.0.1:4182`へproxyする。

```sh
npm run dev -w @mmt/web
npm run typecheck -w @mmt/web
npm run build -w @mmt/web
npx --no-install vitest run apps/web/src/api apps/web/src/lib
```

- `src/api/`: shared contractsを使うHTTP clientと入力型。
- `src/hooks/`: 認証、API読み込み、保存、版選択、ジョブ起動。ジョブのenqueue失敗時は作成済みRunを再利用する。
- `src/pages/`、`src/dialogs/`、`src/components/`: 画面と登録・版作成・起動の操作。
- `src/lib/`: 入力、互換性、フィルタ、表示、メトリクス、Lineageの純粋ロジック。
- `src/types/`: フォーム・選択肢・実行カタログの型。
- `src/i18n/`: UI文言とRuntime・自動実行結果の表示名。
- `public/fonts/`: 利用者提供HTMLから取り込んだIBM Plex。ライセンス同梱。

ブラウザ検証は既存のPlaywrightを使える。root manifest/lockfileへ依存を追加する必要はない。

```sh
export MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
export MMT_CHROMIUM_PATH=/path/to/chromium
node apps/web/tests/browser-smoke.mjs
node apps/web/tests/browser-containers.mjs
node apps/web/tests/browser-workbench.mjs
node apps/web/tests/browser-integration.mjs
node apps/web/tests/browser-followup-integration.mjs
```

`browser-smoke.mjs`はブラウザ内で検証用APIを使い、API障害・enqueue失敗・全画面・Pluginの動線を確認する。fixtureは`tests/`のみで、production bundleに含めない。

コード版はPython/Docker/Singularity/Apptainerを選べる。Docker imageはdigest固定、SIFはProjectの保存済みArtifactを検索・選択しSHA256を自動入力する。SIFの新規uploadも既存upload画面を使う。コンテナのsourceとcwdは任意、実行コマンドはargvのJSON配列。Compute targetの対応Runtimeを表示し、手動launchと自動実行ルールのTarget選択を制限する。

Model Registryの自動実行ルールはProject admin/global adminが作成・有効無効を切り替え、viewer/editorは閲覧する。実行種別はInference/Evaluation、実験・コード版・入力データセット版・Targetを固定する。設定変更は新規ルール作成で行い、PATCHはenabledだけを送る。履歴には起動登録の結果と現在のRun/Job状態を別々に表示し、Run・Jobへのリンクを付ける。

`browser-containers.mjs`はAPI mocksでRuntime登録、保存済みSIFの選択とupload、Target互換性、ルール作成の保存失敗と再試行、enabledだけのPATCH、Project admin/global adminとviewer/editorのUI、履歴のRun/Jobリンクを検証する。実APIの登録・外部コンテナ実行は行わない。

`browser-workbench.mjs`もAPI mocksを使い、次を検証する。
- コード版の編集: Gitの固定commitに重ねる変更（追加・編集・削除）、複数ファイル、パスの衝突、保存失敗、元の版が変わらないこと。
- 未保存の変更の確認と、スマホ幅のダイアログ。
- Standaloneのサンプルとテストコマンド。
- Task: 作成、コード版の編集、改訂番号を固定したテスト実行・通常実行、実行snapshot。
- 計算機の編集と有効・無効（保存失敗を含む）。
- Pluginの設定例・編集・有効無効・manifest、権限による表示の違い。
- Monacoをエディタを開くまで読み込まず、workerを同じoriginから読むこと。

`storage:metrics`対応Pluginの詳細には、Prometheusから読み取ったconnection/bucket/prefix別の容量・件数・計測時間・失敗回数を表示する。未計測値は補完せず、元の値はtooltipと折りたたみraw表示に残す。Parserは[Prometheus text exposition](https://prometheus.io/docs/instrumenting/exposition_formats/)のsample形式を扱う。Plugin登録は全体管理者、登録済みPluginの利用はProject adminに限る。

`browser-followup-integration.mjs`は実APIのデモでRuns既定列を確認し、ローカルの`Web followup permissions`プロジェクトで全体管理者による登録・Project adminのAPI403・既存Pluginの検査/searchのエラー表示・再送を検証する。未設定のlocalhost接続を検証記録として残し、実Mado collectorへの接続成功とは扱わない。繰り返し実行時は同じ検証プロジェクトと接続を使う。

`browser-integration.mjs`はlocalhostの実APIに検証用プロジェクトを作り、登録・Artifacts・trainingジョブのenqueue/cancel/retry・token失効・設定の保存を確認する。root担当が用意したdevelopment API、明示投入したデモ、Local CPU targetを前提にする。実行後も検証記録をDBに残す。SSH接続や外部のモデル取得は行わない。

`browser-pipeline.mjs`は学習→自動登録→推論→評価→判定・昇格を実際の画面で通す。`tests/fixtures/pipeline/serve.ts`がテスト専用DBの新しいschemaで`AUTH_MODE=local`のAPIとビルド済みWeb（`npm run build -w @mmt/web`が先に要る）を47002で配信し、CPU workerも自分で起動・停止する。ローカルログインと初回のパスワード変更、保存先の接続テスト、Project作成、コード版、評価rule、昇格policy、出力モデル付きTask、モデル版画面の推論・評価・metrics・基準比較、理由付きの昇格、alias履歴、group bindingでviewerにしたユーザーが操作できないことを確かめる。`MMT_TEST_DATABASE_URL`が要る。手順と段階は[docs/verification.md](../../docs/verification.md)の「学習から判定・昇格までを通す」。

`MMT_SCREENSHOT_DIR`を指定すると閲覧用画像を保存する。Authentikの実provider、SSH GPU、S3、実Mado serviceの接続は各環境で別途確認する。
