# MLflow 3から記録する

公式の`mlflow` Python SDKから、Mado Model TrackingのProjectへ実験を記録します。接続先はProjectごとに分かれ、認証には既存のAPI tokenを使います。Run・メトリクス・Artifact・登録モデルは通常の画面と同じデータとして保存します。

対応対象はMLflow 3です。公式SDKのMLflow 3.0.0＋scikit-learn 1.6.1、MLflow 3.17.0＋scikit-learn 1.9.1で実HTTPの結合検証を行いました。MLflowの全機能を提供するサーバーではなく、対応機能はこの文書で示します。

## 接続する

API tokenの画面で対象Projectのtokenを作成します。記録するユーザーにはProjectのeditor以上の権限が必要です。tokenは用途に合わせて次のscopeを指定します。

| 用途 | scope |
| --- | --- |
| Experiment・Run・モデル・Artifactの読み出し | `read` |
| Experiment・Run・params・metrics・tags・既存入力Datasetの記録 | `runs:write` |
| 入力Datasetの新規登録 | `runs:write`と`registry:write` |
| Artifactのアップロード | `artifacts:write` |
| Logged Models・モデル版・aliasの登録や変更 | `registry:write` |

Authentikのログインはブラウザでの操作に使います。Pythonの記録には個人tokenまたはService Account tokenを使い、失効・期限・Projectへの所属・scopeはリクエストごとに確認します。

学習を実行するマシンのターミナルで設定します。`PROJECT_ID`は記録先ProjectのUUIDへ置き換えてください。`http://10.0.10.160:5182`はこの開発環境のURLです。別の配置ではそのWeb/APIのURLに変更します。

```bash
python -m pip install 'mlflow>=3,<4'
export MLFLOW_TRACKING_URI='http://10.0.10.160:5182/api/mlflow/projects/PROJECT_ID'
export MLFLOW_REGISTRY_URI="$MLFLOW_TRACKING_URI"
read -r -s -p 'API token: ' MLFLOW_TRACKING_TOKEN
export MLFLOW_TRACKING_TOKEN
```

tokenをソースコードやGit管理ファイルへ書かないでください。コンテナでは環境変数として渡します。

## RunとArtifactを記録する

既存のMLflowの呼び出しを使えます。特別なクライアントpluginのインストールやSDKの変更は不要です。

```python
from pathlib import Path
import mlflow

mlflow.set_experiment("qwen3-finetuning")
with mlflow.start_run(run_name="learning-rate-2e-5"):
    mlflow.log_params({"learning_rate": 2e-5, "epochs": 3})
    mlflow.set_tags({"model_family": "qwen3", "dataset": "training-v1"})
    mlflow.log_metric("train.loss", 0.42, step=100)
    mlflow.log_metric("train.loss", 0.31, step=200)
    Path("predictions.json").write_text('{"text": "sample"}')
    mlflow.log_artifact("predictions.json", artifact_path="evaluation")
```

メトリクスはstepとtimestampを保存します。最新値は到着順ではなくstepとtimestampで決まり、履歴は`MlflowClient.get_metric_history()`で取得します。同じparamには同じ値を再送できます。違う値で上書きするとエラーになります。条件を変えた実験には新しいRunを使ってください。

NaNは保存・読み出し時に保持します。数値検索では`!=`以外に一致させず、昇順・降順とも数値、NaN、未記録の順に並べます。Logged Modelでもこの規則を使い、MLflowのSQLストアがLogged ModelのNaNを0へ変換する動作は再現しません。

SDKが表示するRunリンクはMLflow標準UIの形式です。画面での確認には本アプリのRunsを使うか、`/projects/PROJECT_ID/runs/RUN_ID`を開いてください。

ArtifactはProjectで選んだS3互換ストレージまたはファイルシステムに保存します。SDKへストレージの認証情報を渡す必要はありません。アップロード・ダウンロードはAPIを経由し、大きいファイルはストリームで転送します。同じRun内の同じpathへ再保存すると、新しいArtifactを保存してpathの参照を切り替えます。既存のモデル版が参照するArtifactは保持します。

SDKの`MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true`は設定したままで使えます。multipart uploadには未対応のため、`mpu/create`・`complete`・`abort`は501 `NOT_IMPLEMENTED`を返します。SDKはこの応答を受けて、同じファイルを1回のストリーム転送でアップロードし直します。SDKはエラーmessageの先頭が自身の定数と一致するときだけ通常転送へ戻るので、サーバーはSDKと同じ英語の文言を返します。

## モデルと入力Datasetを記録する

MLflow 3のLogged Modelを作り、必要に応じてModel Registryへ登録します。重み・`MLmodel`・依存関係・入出力signatureはモデルのArtifactとして保存します。

```python
import mlflow
import mlflow.sklearn
import numpy as np
from sklearn.linear_model import LinearRegression

features = np.array([[0.0], [1.0], [2.0]])
targets = np.array([1.0, 3.0, 5.0])
with mlflow.start_run():
    mlflow.log_input(
        mlflow.data.from_numpy(features, targets=targets, name="training-v1"),
        context="training",
    )
    model = LinearRegression().fit(features, targets)
    recorded = mlflow.sklearn.log_model(model, name="regression")

version = mlflow.register_model(recorded.model_uri, "regression")
mlflow.MlflowClient().set_registered_model_alias("regression", "candidate", version.version)
loaded = mlflow.pyfunc.load_model("models:/regression@candidate")
print(loaded.predict(features))
```

入力Datasetのname・digest・source・schema・contextをDatasetVersionとRunへ結び付け、lineageに残します。Datasetのsource URLからデータ本体を自動取得する処理はありません。Model Registryへの登録は既存のモデル版登録処理を通り、生成元Run、親モデル、Artifactの参照を固定します。

MLflowから登録した版は、モデル一式のArtifactを版ごとに固定して読み出します。元のRunのファイルを上書きしたり、Logged Modelを削除したりしても、登録した版の内容は変わりません。モデルの読み込みは`models:/名前/版`または`models:/名前@alias`を使います。lineage画面には入力Dataset、生成元Run、Logged Model、登録したモデル版の関係を表示します。

Logged Modelの取得・検索では全メトリクスを返します。メトリクスの条件検索は過去の評価も含む保存点の一致で判定し、並び替えにはtimestamp、stepの順で選ぶ最新評価を使います。Runの最新値を選ぶ規則とは分けています。

モデル登録後の自動評価に接続する場合は、登録モデルのtagに`mmt.model_family`を指定し、その系列に対応する自動実行ルールをProjectで用意します。

```python
client = mlflow.MlflowClient()
client.create_registered_model("qwen3", tags={"mmt.model_family": "qwen3"})
```

`mmt.code_version_id`で既定のCodeVersionを指定できます。モデル本体のArtifactが複数候補に当てはまる場合は、`mmt.weights_path`でモデル内の相対pathを指定します。モデルと実行コードの系列・Projectの対応は既存の検証を通ります。登録済み版の実行設定はtagを書き換えて変更できません。

複数ファイルを使うモデルは、`MLmodel`のflavorが示す保存済みディレクトリをモデル本体として扱います。この場合のモデル版は`MLmodel`と一式のArtifactを保持します。推論コードでは`mlflow.pyfunc.load_model()`で版を読み込んでください。単一の重みファイルを読むコードには`mmt.weights_path`を明示します。Hugging Face・TensorFlowなどの実モデルでの確認は別途必要です。

## 検索で使える条件

検索条件は`AND`でつなぎます。`OR`と括弧によるグループ化には対応していません。

| 対象 | 使える条件 |
| --- | --- |
| `search_runs` | 属性・`params`・`tags`・`metrics`・`datasets`の比較。`IN`/`NOT IN`は`run_id`と`datasets`の属性。`IS NULL`/`IS NOT NULL`は`params`と`tags` |
| `search_model_versions` | `name`・`run_id`・`model_id`・`source_path`・`version`・時刻・`tags`の比較。`IN`/`NOT IN`は`name`・`run_id`・`model_id`・`source_path` |
| `search_registered_models` | `name`・時刻・`tags`の比較。`IN`/`NOT IN`は使えません |

`IN`/`NOT IN`の値は`run_id IN ('a', 'b')`のように括弧で囲み、引用符付きの文字列をカンマで区切ります。括弧のない値や空の一覧はエラーになります。`NOT IN`はSQLの規則に従い、値が無い版（生成元Runの無い版の`run_id`など）には一致しません。

`get_latest_versions`は使えます。stageごとに最新の版を返し、削除した版は含めません。

## 認証方式の対応状況

SDKからはAPI tokenを`MLFLOW_TRACKING_TOKEN`（Bearer）で渡します。passwordにAPI tokenを入れるBasic認証（`MLFLOW_TRACKING_USERNAME`/`MLFLOW_TRACKING_PASSWORD`）は社内ツールとの互換のために受け付ける方針で、第4波のService Accountの実装（auth-service-accounts）で追加します。それまではBearerを使ってください。

## autologを使う

scikit-learnの実行では次のように自動記録できます。

```python
import mlflow
import mlflow.sklearn

mlflow.set_experiment("automatic-training")
mlflow.sklearn.autolog(log_models=True, log_datasets=True)
model.fit(features, targets)
```

autologはライブラリごとに使用するAPIとモデル形式が異なります。検証対象を明示し、未検証のライブラリまで対応済みとは扱いません。Tracing・GenAI評価・Gateway・Prompt Registry等は今回の対応範囲に含めません。

## workerから記録する

workerはPython・Docker・Singularity・Apptainerの実行環境にMLflowの接続先・token・Experiment ID・Run IDを渡します。PythonのrequirementsまたはコンテナにMLflow 3を含めてください。記録コードの`mlflow.start_run()`はJobが使用するRunに接続します。

Jobの終了はworkerが管理します。SDKの`end_run()`が呼ばれても、子プロセスが動いている間はJobとRunを完了しません。プロセスの終了、出力の回収、停止確認を終えた後にworkerが最終状態を確定します。実行条件の既存paramsを違う値で書き換えることはできません。

JobのRunに追加したSDKのparamsは記録用の`recordedParameters`へ保存し、画面やSDKでは実行paramsと合わせて表示します。workerが再接続・再実行で使う実行条件を変更しません。

## 検証する

開発API/Webとlocal executorを起動し、公式SDKを入れたPython環境で実行します。

```bash
uv venv --python 3.13 artifacts/verification/mlflow3-venv
uv pip install --python artifacts/verification/mlflow3-venv/bin/python \
  'mlflow==3.17.0' 'scikit-learn==1.9.1' -e ./python
artifacts/verification/mlflow3-venv/bin/python scripts/verify_mlflow3.py
```

multipart uploadの通常転送への切り替えも確かめる場合は、`MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true`と、検証用ファイルより小さい`MLFLOW_MULTIPART_UPLOAD_MINIMUM_FILE_SIZE`（例: `1048576`）を付けて実行します。このとき検証は、しきい値を超えるArtifactのアップロード・ダウンロード結果と、`mpu/create`の501応答を確認します。

検証用Project・token・CPU target・自動実行ルールを作り、終了時にtokenを失効しルールを無効化します。Runとモデルは確認用に残します。結果は`artifacts/verification/<日付>/mlflow3/sdk-integration.json`へ保存します。

この検証は公式SDKとHTTP APIの互換性を確かめます。実SSH/GPU、Authentik、実S3の接続確認は別途行います。
