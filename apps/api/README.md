# API

Hono API、PostgreSQL migration、認証とトラッキングのサービスを置く。HTTPの正本は[API契約](../../docs/api-contract.md)、公開型は[@mmt/contracts](../../packages/contracts/src/index.ts)を参照する。

## 起動

依存のinstallと開発DBの作成はroot担当が行う。`MMT_DATABASE_URL`、またはfallbackの`DATABASE_URL`を設定し、repo rootから実行する。

```bash
npm run db:migrate -w @mmt/api
npm run start -w @mmt/api
```

既定は`HOST=127.0.0.1`、`PORT=4182`、`AUTH_MODE=oidc`。開発ログインを使う場合は`AUTH_MODE=development`を明示する。productionではdevelopment modeを拒否する。

- `MMT_PUBLIC_URL`: ブラウザからAPIに届くURL。Vite proxyを使う開発環境では`http://127.0.0.1:5182`にする。
- `MMT_WEB_ORIGIN`: Cookieで変更要求を送れるWebのOrigin。既定は`http://127.0.0.1:5182`。
- `OIDC_ISSUER_URL`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`: Authentikの設定。callbackは`{MMT_PUBLIC_URL}/api/auth/callback`。client secretがない場合はpublic clientとしてPKCEを使う。
- `OIDC_ADMIN_GROUP`: global adminに対応するOIDC groups claim。既定は`mmt-admins`。OIDC identityはissuerとsubjectで結び、verified emailが必要。
- `OIDC_ALLOW_INSECURE_HTTP=true`: 非productionのloopback mock providerに限りHTTPを許可する。
- `DEVELOPMENT_ADMIN_EMAIL`: 開発管理者のemail。既定は`admin@localhost`。開発ログインbodyは`{email?,displayName?}`。
- `MMT_ALLOW_LOCAL_EXECUTOR=true`: developmentでlocal targetの実行を許可する。SSH targetの実行には不要。
- Artifactとpluginの環境変数はAPI契約を参照。Artifactの保存先は絶対パスを推奨する。相対パスはAPIの起動ディレクトリを基準にする。

Migrationは起動時に自動適用しない。適用済みSQLのdigestを確認し、改変されたmigrationは拒否する。

## Seed

```bash
AUTH_MODE=development MMT_ALLOW_SEED=true MMT_ALLOW_LOCAL_EXECUTOR=true npm run db:seed -w @mmt/api
```

Seedは明示許可でのみ動く。CPU線形回帰を実際に計算し、metricsとweightsを保存する。生成音声も`ArtifactStores.put`で保存する。Qwen2/Qwen3は公開モデルの参照と未実行のRunを登録する。実行可能なinline Pythonの学習・fine-tuning・推論code、local CPU target、admin/editor/viewerを用意する。

成功後の再実行はデータを増やさない。途中で失敗したseedや同名Projectがある場合は、成功済みと扱わずエラーを返す。ログインできる例は`admin@localhost`、`editor@localhost`、`viewer@localhost`。管理者emailを変更した場合はその値を使う。

## 検証

親担当が作成した独立test DBのみを使う。通常のDB URLをtestに流用しない。test DB内で専用schemaを作ってmigrationを適用し、終了時にschemaと一時Artifactを削除する。

```bash
MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55483/mmt_test npm test -w @mmt/api
npm run typecheck -w @mmt/api
```

`MMT_DATABASE_URL_TEST`も受け付ける。どちらもない場合、DB統合テストはskipする。suiteは`app.request`でHTTP認可・入力検証を通す。OIDCは実HTTPのmock providerでPKCE、state、nonce、署名、ブラウザbindingを検証する。

## 実行と配送の整合性

- バージョンは更新不可。Runのモデル・コード・入力データセットは作成時に実際のバージョンIDで保存する。
- CodeVersionの`runtime`はPython/Docker/Singularity/Apptainer。省略時はPython。Dockerはdigest固定、SIFは同じProjectの保存済みArtifact/hashで照合する。コンテナはsourceなしでも登録できる。Runの`environment.runtime`は変更不可。
- targetの`runtimeKinds`は省略時にPython。Job登録とworker claimは対応runtimeと固定runtimeを検証する。
- モデル自動実行のruleはProject/global adminだけが作成し、設定変更は新しいruleで行う。有効化/無効化だけPATCHできる。モデルバージョンの登録transaction内で有効ruleを実行し、Run/Job/executionを一度だけ作成する。単なるArtifact uploadや過去のモデル登録では起動しない。
- ruleのcreator権限失効と重みなしはskipを記録する。ruleごとの失敗はsavepointでRun/Jobをrollbackし、failureを保存してモデル登録を維持する。履歴は最新100件で、登録結果と現在のRun/Job状態を別のフィールドで返す。
- worker tokenには`worker:execute`、project、editor以上の現在のmembershipが必要。SDKからArtifactやRegistryを登録する場合は、用途に合わせ`read`、`runs:write`、`artifacts:write`、`registry:write`を追加する。
- claimはJobの`SKIP LOCKED`とtargetのrow lockを使う。CPU Jobもtargetの同時実行数に含める。GPUは同一transactionで予約する。
- leaseは同じtokenとworkerIdに結びつける。claim再送とresumeは同じleaseを返す。並行監視するworkerはclaimの`activeJobIds`に監視済みのJobを指定すると、次のJobを取得できる。heartbeatが途絶えても自動再queueしない。状態不明のremote processを二重起動しないため、cancel要求だけではGPUを解放しない。
- 完了はleaseを検証し、Run/Job更新、GPU解放、plugin outbox保存を同じtransactionで行う。同じ完了の再送はeventを増やさない。
- API serverのoutbox workerが配送を再試行する。plugin障害でも完了したRunは維持する。eventのIDは再送時も同じ。配送中にserverが停止した場合は配送leaseの期限後に回収するため、plugin側もevent IDで重複を防ぐ必要がある。
- Artifactはstreamingで保存する。blob保存後にDB登録が失敗した場合はblobを削除する。cleanup自体が失敗した場合はArtifact IDを構造化ログに残す。
