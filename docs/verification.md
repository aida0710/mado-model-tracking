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

同日の最終検証はTypeScript 349件成功・実S3 fixture未起動の2件skip、Python 188件と実Docker worker 20件が成功しました。型検査、ビルド、strict mypy、ruffも通過しています。レビューで見つかった並行保存・改名のlock順、NaN検索、モデルの全メトリクス履歴/検索/並び順、SDK記録後のUIの数値・真偽値filterを回帰テストで確認しました。

画面の確認は3.17の結果ファイルを使います。

```bash
MMT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
MMT_CHROMIUM_PATH=/path/to/chromium \
node scripts/verify_mlflow_browser.mjs
```

SDKで作成したRunのメトリクス/params、モデル一式のArtifact、自動評価の推論結果、alias、data/model lineageを確認して画像と`browser-integration.json`を保存します。`MMT_WEB_URL`にLAN URLを指定すればprivate Originも含めて確認できます。
