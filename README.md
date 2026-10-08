# Mado Model Tracking

実験、モデル、実行コード、データセットを同じRunに結び付ける実験管理アプリです。Madoとは別に動作し、最初の外部連携を[Mado plugin](../mado-model-tracking-plugin-mado/README.md)で提供します。

React/Viteの画面、TypeScript/HonoのAPI、PostgreSQL、Python SDKとSSH workerで構成します。学習・fine-tuning・推論・評価・データ加工を扱います。ArtifactsはファイルシステムまたはS3互換ストレージをProjectごとに選びます。[公式MLflow 3 SDK](docs/mlflow.md)からも記録できます。

## ローカルで起動する

Node.js 22.12以降、PostgreSQL 16以降、Python 3.11以降が必要です。workerにはOpenSSH clientも必要です。

```bash
npm ci
cp .env.example .env
chmod 600 .env
```

開発用DBを新規に用意する場合は次を使えます。既に同名のcontainerがあれば起動だけ行ってください。trust認証はlocalhostの開発fixture専用です。

```bash
docker run -d --name mmt-dev-postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=mmt -e POSTGRES_DB=mmt \
  -p 127.0.0.1:55483:5432 -v mmt-dev-postgres:/var/lib/postgresql/data postgres:16-alpine
docker exec mmt-dev-postgres createdb -U mmt mmt_test
npm run db:migrate
npm run dev
```

[http://127.0.0.1:5182](http://127.0.0.1:5182)を開き、開発ログインします。初期状態は空です。ProjectとExperimentを登録して使い始めます。確認用データを入れる場合だけ`.env`に`MMT_ALLOW_SEED=true`を設定して`npm run db:seed`を実行します。開発ログイン・seed・local executorは本番で無効です。

LANからは`http://<このマシンのprivate IP>:5182`を開けます。`.env.example`は`MMT_ALLOW_PRIVATE_ORIGINS=true`を設定しています。既存の.envにも追加し、APIを再起動してください。許可範囲とSSOの固定URLは[運用手順](docs/operations.md)にあります。

CPUだけで実行を試す場合は`MMT_ALLOW_LOCAL_EXECUTOR=true`にし、local targetを登録します。[workerの手順](docs/worker.md)に従ってProject用Service Account tokenでworkerを起動します。実際のGPU実行ではSSH target、GPU ID、秘密鍵とknown_hostsをworker側に用意します。

## 管理するもの

- **Run**: パラメータ、タグ、時系列メトリクス、ログ、GPU使用率、実行環境。Run比較とメディアのArtifactプレビュー。
- **ModelVersion**: 重み、親モデル、生成元Run、モデル系列、既定CodeVersion。aliasを解決して実際の版をRunへ保存。
- **CodeVersion**: 固定Git commit、inlineのソース、保存したzip/tar、またはコンテナ内のコード。Python・Docker・Singularity・Apptainerの実行環境、起動コマンド、対応モデル系列、実行種別。
- **DatasetVersion**: URI、digest、schema、加工元の版、生成元Run。外部DatasetVersionのIDも保持。
- **Job**: SSH接続先、GPU予約、キュー、ログ、停止、再実行。再実行は新しいRunを作り、元の記録を保持。
- **モデルの自動実行**: モデル版の登録完了後、系列に合うルールで推論・評価をキューへ登録。コード・データセット・コンテナの版を固定し、同じ登録イベントの重複を防止。
- **認証**: Authentik OIDC、Projectのviewer/editor/admin、期限・scope・失効を持つ個人tokenとService Account token。
- **Plugin**: 別サービスのHTTP契約。データセット検索・取り込み、Run lifecycleのlineage送信、Mado容量metricsの参照。

モデル系列とCodeVersionの対応はAPIとworkerで検証します。モデル版とデータセット版は不変です。ジョブは起動時のコード・モデル・データセットをsnapshotとして使います。

## 設定と検証

[運用・Authentik・保存先](docs/operations.md)、[コンテナ・モデルの自動実行](docs/containers-automation.md)、[API契約](docs/api-contract.md)、[plugin仕様](docs/plugins.md)、[検証手順](docs/verification.md)を参照してください。Python SDKの使用例は`python/examples/`にあります。

MLflow 3の接続先・API token・Runとモデルの記録・autolog・workerでの使用方法は[MLflow 3の手順](docs/mlflow.md)を参照してください。

```bash
npm run typecheck
npm run build
MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55483/mmt_test npm test
cd python
uv sync --extra test --extra telemetry
uv run pytest
```

実際のAuthentik client、SSH GPU接続先、S3保存先は環境に合わせて設定します。外部サービスに接続していないテスト結果を、本番接続の確認として扱わないでください。
