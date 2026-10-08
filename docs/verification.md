# 検証手順

DBテストは専用の`mmt_test`へ接続し、テスト専用schema内でmigrationを適用します。開発DBや既存Mado DBを渡さないでください。

```bash
npm run typecheck
npm run build
MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55483/mmt_test npm test
cd python
uv sync --extra test --extra telemetry
uv run pytest
```

S3のprotocolテストは別のterminalでMotoのローカルemulatorを起動して実行します。通常の`npm test`ではS3接続テストはskipされます。

```bash
uv tool run --from 'moto[server]==5.2.1' moto_server -H 127.0.0.1 -p 4569
MMT_TEST_S3_ENDPOINT=http://127.0.0.1:4569 npm test -- packages/platform/src
```

S3テストは専用bucketを作り、multipart upload、保存byte数とSHA-256、Range取得、失敗upload、削除を確認してbucketを消します。emulatorの結果は実際のS3権限やネットワークの確認を含みません。

## 実S3の保存・取得を確認する

`scripts/verify_s3_artifacts.ts`は、`.env`のS3設定（`S3_BUCKET`、`S3_ENDPOINT`、`S3_REGION`、`S3_PREFIX`、`S3_FORCE_PATH_STYLE`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`）を使い、APIと同じ`createS3ArtifactStore`で既存bucketを検証します。bucketは作成しません。書き込みは`<S3_PREFIX>/verification/<JSTの日付>/<uuid>/`の下に限り、最後にそのprefixのobjectと未完了のmultipart uploadを消します。

実bucketで実行する前に、利用者がbucket、`S3_PREFIX`、認証情報を置く.envの変数名、書き込み・削除してよい範囲を決めます。決まったら、確認の印として`MMT_VERIFY_S3_CONFIRM=write-and-delete`を付けて実行します。付けない場合は何もせず終了コード2で止まります。

```bash
MMT_VERIFY_S3_CONFIRM=write-and-delete MMT_VERIFY_S3_LABEL=<検証対象の呼び名> \
node_modules/.bin/tsx scripts/verify_s3_artifacts.ts
```

| 段階 | 確認すること |
|---|---|
| `small-put-get` | 小さいobjectの保存byte数・SHA-256と全体取得 |
| `range-and-suffix-range` | 明示Range、suffix range（`bytes=-500`）、末尾指定なし、範囲外の終端の切り詰め、満たせないRangeの拒否 |
| `multipart-over-16mib` | 17MiB超をmultipartで保存し、digest、partの境界をまたぐRange、ETagのpart数を照合 |
| `interrupted-multipart-cleanup` | 2 part送った後に送信元を中断し、objectが見えないことと、ListMultipartUploadsから消えることを確認 |
| `outside-prefix-denied` | `S3_PREFIX`の外へのPut/Getが拒否されるか（IAMの範囲確認） |
| `remove` | 削除後に読めないことと、2回目の削除が成功すること |
| `cleanup-run-prefix` | 検証prefixの残りを消し、空になったことを確認 |

結果は`artifacts/verification/<日付>/s3/s3-integration.json`に保存します（`MMT_VERIFY_S3_OUTPUT`でファイル名を変更可）。bucket名、endpoint、object key、認証情報は書きません。SDKのエラーは、名前、HTTP status、ネットワークのエラーコードだけを残します。失敗が1件でもあれば終了コードは1です。

warningは「失敗ではないが、利用者が判断すること」を示します。

- `outside-prefix-denied`: prefixの外へ書けた・読めた。書けた場合はすぐ削除し、`outsideObjectRemoved`に記録します。外側のprefixは`MMT_VERIFY_S3_OUTSIDE_PREFIX`（既定`mmt-verification-outside-prefix`）で、不要なら`MMT_VERIFY_S3_SKIP_OUTSIDE_PREFIX=true`で省きます。書き込みを拒否された場合、Getは存在しないkeyへ送ります（`getTarget=missing-key`）。存在しないkeyへのGetは、読み取りと一覧の両方の権限があると404、どちらかが無いと403になります。404ならprefixの外を読めます。403は一覧の権限が無いだけでも返るので、読み取りの拒否を厳密には示しません。`S3_PREFIX`が空なら比較できないのでskipします。
- `interrupted-multipart-cleanup`: `abortFinishedBeforeReject=false`は、保存の失敗が返った時点ではAbortMultipartUploadが終わっておらず、後から消えたことを示します（`pendingUploadGoneAfterMs`）。その間にprocessが落ちると未完了のpartが残るので、実bucketにはAbortIncompleteMultipartUploadのlifecycle ruleを設定してください。ListMultipartUploadsの権限が無い場合もwarningです。
- `multipart-over-16mib`: ETagにpart数が無いS3互換サービスではwarningにします。

Motoで試す場合は、別terminalで起動したemulatorにbucketを作ってから、環境変数で接続先を渡します。`MMT_VERIFY_ENV_FILE=none`で`.env`を読みません（環境変数は常に`.env`より優先します）。

```bash
uv tool run --from 'moto[server]==5.2.1' moto_server -H 127.0.0.1 -p 4569
MMT_VERIFY_ENV_FILE=none MMT_VERIFY_S3_CONFIRM=write-and-delete MMT_VERIFY_S3_LABEL=moto \
MMT_VERIFY_S3_OUTPUT=s3-integration-moto.json \
S3_BUCKET=<作成したbucket> S3_ENDPOINT=http://127.0.0.1:4569 S3_FORCE_PATH_STYLE=true \
S3_PREFIX=mado-model-tracking S3_ACCESS_KEY_ID=testing S3_SECRET_ACCESS_KEY=testing \
node_modules/.bin/tsx scripts/verify_s3_artifacts.ts
```

2026-10-08にMoto 5.2.1で実行し、失敗0件でした。MotoはIAMを評価しないため`outside-prefix-denied`はwarningになります。`interrupted-multipart-cleanup`もwarningで、未完了uploadは保存の失敗が返ってから約0.2秒後に消えました。実bucketでの実行は未確認です。

ローカルJobの結合検証では、実APIにコード・モデル・データセットを登録してPython workerで実行します。Runの完了、メトリクス、Artifact、モデル登録、data/model lineage、親の重みからのfine-tuning、2 Jobの並列実行、停止、再実行、worker復帰を確認します。CPUの小さいfixtureはモデル学習の精度やGPU性能を検証するものではありません。

OIDCテストは署名鍵を持つローカルproviderでAuthorization Code＋PKCEを実行し、state/nonce/署名、ブラウザbinding、scope/Project権限を確認します。実際のAuthentik設定は[運用手順](operations.md)で確認します。

確認用スクリーンショットと実行結果はgitignoreした`artifacts/verification/<日付>/`に保存します。認証情報を画像やJSONへ含めません。

## 実APIの結合検証を再実行する

開発API/Webを起動し、API/worker双方のlocal executorを許可して実行します。検証用ProjectとComputeTargetを作り、終了時に一時Service Account tokenを失効します。結果を確認しやすいようRunと登録データは残します。

```bash
PYTHONPATH=python/src python/.venv/bin/python scripts/verify_worker.py
MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
MMT_CHROMIUM_PATH=/path/to/chromium \
node scripts/verify_browser.mjs
```

`MMT_VERIFY_PYTHON`にvenv/pipを使えるPythonの絶対パスを指定します。worker検証の後にbrowser検証を行うと、実際の学習Runとlineageを撮影できます。

## モデルの自動実行と実Dockerを確認する

開発APIとlocal executorを用意し、Docker daemonを操作できるユーザーで実行します。検証用Project・Target・ルールを作り、CPU用の固定digestイメージでモデル登録から推論/評価、結果の回収、停止、worker再接続まで確認します。終了時にルールを無効化し、一時tokenを失効します。

```bash
docker pull node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
PYTHONPATH=python/src python/.venv/bin/python scripts/verify_containers.py
MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
MMT_CHROMIUM_PATH=/path/to/chromium \
node scripts/verify_container_browser.mjs
```

`MMT_VERIFY_CONTAINER_IMAGE`で同じNodeコマンドを使える別のdigest固定イメージへ変更できます。`artifacts/verification/<日付>/containers/container-integration.json`に結果を保存します。browser検証はそのProjectを使い、画面からDockerのコード版と無効なルールを新規登録し、有効／無効の切り替えを実APIで確認します。検証後はルールを無効に戻し、同じディレクトリへ結果と画像を保存します。

GPUは使用しません。Singularity/Apptainerの起動・停止・SIF照合はPythonのテストで確認し、実SIF runtimeでの実行確認とは区別します。

## Madoとのplugin連携を確認する

Mado拡張worktreeと別pluginリポジトリが隣にあれば、次で本体→plugin→Mado routesの接続を確認します。Mado Registryは隔離fixtureを使います。

```bash
MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55483/mmt_test \
node_modules/.bin/tsx scripts/verify_mado_plugin.ts
```

配置が違う場合は`MMT_VERIFY_MADO_ROOT`と`MMT_VERIFY_PLUGIN_ROOT`を指定します。こちらのテストは専用schemaを最後に削除します。

## 公式MLflow 3 SDKを確認する

[MLflowの手順](mlflow.md)に従って、隔離Python環境へ公式SDKとscikit-learn、本体Python SDKを入れます。開発API/Webとlocal executorを起動し、次を実行します。

```bash
artifacts/verification/mlflow3-venv/bin/python scripts/verify_mlflow3.py
```

Run・nested Run、paramsの不変性、メトリクス履歴/検索、6MiB・空・日本語pathのArtifact転送とhash一致、入力Dataset、Logged Modelの保存/読み込み、Model Registry/alias、scikit-learn autologを公式SDKのまま検証します。モデル登録で自動評価Jobを起動し、実CPU workerから同じRunへSDKで結果を記録します。readonly・Project制限・無効tokenの拒否も確認します。

検証終了時に一時tokenを失効し、ルールを無効化します。結果は`artifacts/verification/<日付>/mlflow3/sdk-integration.json`へ保存します。`MMT_VERIFY_API_URL`を省略するとWebの`/api` proxyを通るため、通常は省略します。専用test schemaで試す場合は`MMT_TEST_DATABASE_URL`を設定して`node_modules/.bin/tsx scripts/serve_mlflow_verification.ts`を起動し、検証APIをloopback4184へ指定します。停止すると専用schemaを削除します。

2026-10-08にはPython 3.13.15でMLflow 3.0.0＋scikit-learn 1.6.1、MLflow 3.17.0＋scikit-learn 1.9.1の両方を検証しました。版別の結果は`sdk-3.0-integration.json`と`sdk-3.17-integration.json`です。未検証の他ライブラリ・実HF/TFモデル・実GPUの動作はこの結果に含めません。

TypeScriptの公式protobuf検証2件は、上記の`artifacts/verification/mlflow3-venv/bin/python`を使います。別のSDK環境を使う場合は`MMT_TEST_MLFLOW_PYTHON`にそのPythonの絶対パスを指定して`npm test`を実行します。SDKが未インストールの場合はこの2件だけskipします。

同日のMLflow互換追加時はTypeScript349件成功・実S3 fixture未起動の2件skip、Python188件と実Docker worker20件が成功しました。型検査、ビルド、strict mypy、ruffも通過しています。レビューで見つかった並行保存・改名のlock順、NaN検索、モデルの全メトリクス履歴/検索/並び順、SDK記録後のUIの数値・真偽値filterを回帰テストで確認しました。

画面の確認は3.17の結果ファイルを使います。

```bash
MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
MMT_CHROMIUM_PATH=/path/to/chromium \
node scripts/verify_mlflow_browser.mjs
```

SDKで作成したRunのメトリクス/params、モデル一式のArtifact、自動評価の推論結果、alias、data/model lineageを確認して画像と`browser-integration.json`を保存します。`MMT_WEB_URL`にLAN URLを指定すればprivate Originも含めて確認できます。

## Task・コード編集・実行前ソース保存を確認する

```bash
PYTHONPATH=python/src python/.venv/bin/python scripts/verify_workbench.py
```

公開Gitリポジトリの固定commitを読み込み、編集・削除したファイルを実CPU workerで実行します。通常とテストのコマンド、Task改版後も固定されるqueued Job、古いrevisionの409、失敗テストと再実行、実行前のsource ZIPとmanifest、履歴を確認します。コード自身がmain.pyを書き換えた場合も、ZIPが実行前の内容を保つことを照合します。検証用tokenは最後に失効し、targetを無効にします。結果は`artifacts/verification/<日付>/workbench/task-integration.json`です。

ブラウザからCompute/plugin登録、Monacoの編集・改版、Task作成・テスト・学習・推論を確認する場合は、開発APIとworkerのlocal executorを許可します。`.env`の`MMT_WORKBENCH_PLUGIN_TOKEN`に検証専用の値を用意してAPIを起動し、別terminalでloopbackのHTTP fixtureを起動します。

```bash
python/.venv/bin/python scripts/serve_workbench_plugin.py
```

```bash
PYTHONPATH=python/src python/.venv/bin/python scripts/setup_workbench_playground.py
MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
MMT_CHROMIUM_PATH=/path/to/chromium \
MMT_WEB_URL=http://<LANのIP>:5182 \
node scripts/verify_workbench_browser.mjs
```

この操作はPlaygroundを残し、そのProjectとCPU targetだけを扱うworkerを起動します。Service Account tokenは7日で失効し、`var/playground/worker-settings.json`へmode600で保存します。ブラウザの確認後もTaskを編集・実行できます。再起動は`PYTHONPATH=python/src python/.venv/bin/python scripts/serve_workbench_worker.py`。workerの停止には`var/playground/worker.pid`のprocessを確認してSIGTERMを送り、設定画面で当該tokenを失効してください。

HTTP fixtureはMadoのprotocol・metrics・Dataset importを確認するための専用サンプルです。実Madoへの接続確認は前節の別plugin検証を使います。PlaygroundのIDと実行結果、閲覧用画像は`artifacts/verification/<日付>/workbench/`へ保存し、tokenの値を含めません。

2026-10-08の追加機能では、API・ストレージ366件、Web98件、Python316件、実Docker20件が成功しました。S3接続fixtureの2件はskipです。型検査・build・ruff・strict mypy、wheel/sdistの45ファイルと現ソースの一致も確認しました。

実APIとCPU workerの5 Jobで、Task改版、通常・失敗テスト、旧版の再実行、Git差分、実行前ZIP、2件ずつの履歴取得を確認しました。実ブラウザでは8 Jobを実行し、Monacoで編集した係数によるメトリクスの7→10の変化、学習モデルを別の推論コードで読み込んだ予測値の一致、Compute/plugin管理、manifest・metrics・Dataset importを確認しました。ブラウザ回帰5本では未保存編集の戻る・進む、ネストした編集、保存待ちと履歴ページ切替も検証しています。公式MLflow 3.17.0の実SDK結合は再確認済みです。

実Authentik、SSH/GPU、実S3、実SIF runtime、本番Madoへの接続はこの結果に含みません。
