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
- `src/i18n/catalog.ts`: UI文言。
- `public/fonts/`: 利用者提供HTMLから取り込んだIBM Plex。ライセンス同梱。

ブラウザ検証は既存のPlaywrightを使える。root manifest/lockfileへ依存を追加する必要はない。

```sh
export MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
export MMT_CHROMIUM_PATH=/path/to/chromium
node apps/web/tests/browser-smoke.mjs
node apps/web/tests/browser-integration.mjs
node apps/web/tests/browser-followup-integration.mjs
```

`browser-smoke.mjs`はブラウザ内で検証用APIを使い、API障害・enqueue失敗・全画面・Pluginの動線を確認する。fixtureは`tests/`のみで、production bundleに含めない。

`storage:metrics`対応Pluginの詳細には、Prometheusから読み取ったconnection/bucket/prefix別の容量・件数・計測時間・失敗回数を表示する。未計測値は補完せず、元の値はtooltipと折りたたみraw表示に残す。Parserは[Prometheus text exposition](https://prometheus.io/docs/instrumenting/exposition_formats/)のsample形式を扱う。Plugin登録は全体管理者、登録済みPluginの利用はProject adminに限る。

`browser-followup-integration.mjs`は実APIのデモでRuns既定列を確認し、ローカルの`Web followup permissions`プロジェクトで全体管理者による登録・Project adminのAPI403・既存Pluginの検査/searchのエラー表示・再送を検証する。未設定のlocalhost接続を検証記録として残し、実Mado collectorへの接続成功とは扱わない。繰り返し実行時は同じ検証プロジェクトと接続を使う。

`browser-integration.mjs`はlocalhostの実APIに検証用プロジェクトを作り、登録・Artifacts・trainingジョブのenqueue/cancel/retry・token失効・設定の保存を確認する。root担当が用意したdevelopment API、明示投入したデモ、Local CPU targetを前提にする。実行後も検証記録をDBに残す。SSH接続や外部のモデル取得は行わない。

`MMT_SCREENSHOT_DIR`を指定すると閲覧用画像を保存する。Authentikの実provider、SSH GPU、S3、実Mado serviceの接続は各環境で別途確認する。
