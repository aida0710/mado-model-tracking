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

Authentikのログインはブラウザでの操作に使います。Pythonの記録には個人tokenまたはService Account tokenを使い、失効・期限・Projectへの所属・scopeはリクエストごとに確認します。自動実行やworkerなど、人の異動で止めたくない記録には、Projectの設定画面「Service Accounts」で作ったService Accountのtokenを使います。tokenの期限は最長365日です。

学習を実行するマシンのターミナルで設定します。`PROJECT_ID`は記録先ProjectのUUIDへ置き換えてください。`http://localhost:5182`は手元の開発環境のURLです。別の配置ではそのWeb/APIのURLに変更します。

Webの設定画面「MLflow 3から接続」に、このProjectの`MLFLOW_TRACKING_URI`／`MLFLOW_REGISTRY_URI`と、コピーできる設定例があります。「このProject用のtokenを発行」は、read・runs:write・registry:write・artifacts:write を選んだ状態でtokenの作成画面を開きます（viewerには表示しません）。

```bash
python -m pip install 'mlflow>=3,<4'
export MLFLOW_TRACKING_URI='http://localhost:5182/api/mlflow/projects/PROJECT_ID'
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

Runの説明文はMLflowと同じ`mlflow.note.content` tagに保存します。MLflowの`set_tag("mlflow.note.content", ...)`・標準UIのDescriptionと、nativeの`PUT /api/projects/:p/runs/:r/note`は同じ値を読み書きし、別の保存場所はありません。上限はMLflowのtag値と同じ8000文字で、nativeで空文字を保存するとtagを削除します。JobのRunが終わった後は、MLflowのset-tag・delete-tagが`INVALID_STATE`で拒否されます。nativeの説明文APIは説明文を実験結果として扱わないため、終了後もeditorが編集できます。終了後に説明文を直す場合はnative APIを使ってください。Job限定token（`mmtj_`）ではnativeの説明文APIは403 `job_token_forbidden`です。WebではRun詳細の［詳細］タブの「説明」で同じ値を編集できます（`RunDescriptionEditor`）。

### 終わったRunに続きを記録する

MLflowの`start_run(run_id=...)`で、終わったRun（中断・失敗を含む）を開き直して続きを記録できます。本アプリはこれを「Runの再開」として記録し、いつ再開したかが残ります。

```python
import mlflow

with mlflow.start_run(run_id="RUN_ID"):
    mlflow.log_metric("train.loss", 0.25, step=301)
```

SDK 3.0.0と3.17.0は、開き直すときに`runs/update`へ`status=RUNNING`と前回の`end_time`を送ります。サーバーはRunをrunningへ戻し、終了時刻とerrorを消して、再開イベントを1件残します。`with`を抜けるとSDKが改めて`FINISHED`と終了時刻を送ります。続きのstepは、`MlflowClient.get_metric_history()`か、nativeの再開APIが返す`lastSteps`で決めてください。

| | MLflow `start_run(run_id=)` | native `POST /api/projects/:p/runs/:r/resume` |
|---|---|---|
| 対象 | Jobの無い終わったRun | Jobの無い終わったRun |
| 再開イベント | `source=mlflow`で1件 | `source=native`で1件（`reason`を付けられる） |
| 実行中のRun | 何もしない（イベントなし） | `resumed:false`（イベントなし） |
| Job付きRun | 状態を変えない（イベントなし。SDKは手元のcontextだけ開く） | 409 `run_finalized` |
| 続きのstep | metric履歴から決める | 応答の`lastSteps`（keyごとの最大step） |

再開の一覧と区間（最初の開始から各再開までの区切り）は`GET /api/projects/:p/runs/:r/resume-events`で読めます。

Job付きRunは、終了後に記録を足すと`INVALID_STATE`になり、再開もできません。Jobの学習を途中から続けるときは、checkpointから新しいRunとして再開してください（Jobのcheckpoint再開）。

ArtifactはProjectで選んだS3互換ストレージまたはファイルシステムに保存します。SDKへストレージの認証情報を渡す必要はありません。アップロード・ダウンロードはAPIを経由し、大きいファイルはストリームで転送します。同じRun内の同じpathへ再保存すると、新しいArtifactを保存してpathの参照を切り替えます。既存のモデル版が参照するArtifactは保持します。

### 大きいファイルのmultipart upload

大きいファイルは、MLflowのmultipart upload（`mpu/create`→partごとのPUT→`complete`）で分割して送れます。途中のpartが失敗しても、SDKはファイル全体ではなくそのpartだけを送り直します。

- MLflow 3.17以降のSDKは`<tracking URI>/api/3.0/mlflow/server-info`を読み、`multipart_uploads_enabled`がtrueなら自動で使います。3.0〜3.16のSDKはserver-infoを読まないので、`MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true`を設定します。
- 使うのは`MLFLOW_MULTIPART_UPLOAD_MINIMUM_FILE_SIZE`（SDKの既定500MiB）以上のファイルで、partの大きさは`MLFLOW_MULTIPART_UPLOAD_CHUNK_SIZE`（既定10MiB）です。chunkは5MiB以上にしてください。最後以外のpartが5MiB未満だと、保存先がファイルシステムでも422で失敗します（S3と同じ規則にしています）。
- part数の上限は10000です。200GiBのファイルなら、chunkを21MiB以上にします。
- `complete`は、API側で全体のSHA-256を計算してArtifactを登録し終えるまで待ちます。待つのは`MMT_UPLOAD_FINALIZE_WAIT_MS`（既定100秒）までで、超えると503が返ります。そのときもAPIは検証を続け、終わればArtifactの一覧に表示されます。数十GBのファイルを送るときは、SDKの`MLFLOW_HTTP_REQUEST_TIMEOUT`（既定120秒）と`MMT_UPLOAD_FINALIZE_WAIT_MS`を大きくしてください。
- partのPUTにはAPI tokenを付けません。`mpu/create`の応答に入るsession限定のupload token（`X-MMT-Upload-Token`）で認可します。tokenの期限はsessionと同じ7日です。
- Job内のコードからも使えます。Job限定token（`mmtj_`）で作れるのは、そのJobのRunとLogged Modelのsessionだけです。
- 運用でmultipartを止めるときは`MMT_MLFLOW_MULTIPART_UPLOADS=false`にします。server-infoはfalseを返し、`mpu/create`・`complete`・`abort`は501 `NOT_IMPLEMENTED`を返します。SDKはこの応答を受けて、同じファイルを1回のストリーム転送でアップロードし直します。SDKはエラーmessageの先頭が自身の定数と一致するときだけ通常転送へ戻るので、サーバーはSDKと同じ英語の文言を返します。空のファイルと、multipartに対応しない保存先でも同じ501を返します。
- multipart download（presigned URLでの直接取得）は作っていません。`MMT_MLFLOW_MULTIPART_DOWNLOADS`は既定のfalseのままにしてください。trueにすると、3.17以降のSDKがpresigned URLの取得に失敗してdownloadが止まります。

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

MLflowのCreateModelVersionとネイティブの`POST /projects/:p/models/:id/versions`（version省略時）は、Modelごとに同じ番号の系列から採番します。交互に登録しても番号は重複せず、削除した版の番号は再利用しません（MLflowと同じ）。明示した整数版で登録した場合は、続きの番号がその版の次まで進みます。整数でない版（`v1`など）と19桁以上の数字は採番の計算から除外します。

MLflowから登録した版は、モデル一式のArtifactを版ごとに固定して読み出します。元のRunのファイルを上書きしたり、Logged Modelを削除したりしても、登録した版の内容は変わりません。モデルの読み込みは`models:/名前/版`または`models:/名前@alias`を使います。lineage画面には入力Dataset、生成元Run、Logged Model、登録したモデル版の関係を表示します。

Logged Modelの取得・検索では全メトリクスを返します。メトリクスの条件検索は過去の評価も含む保存点の一致で判定し、並び替えにはtimestamp、stepの順で選ぶ最新評価を使います。Runの最新値を選ぶ規則とは分けています。

モデル登録後の自動評価に接続する場合は、登録モデルのtagに`mmt.model_family`を指定し、その系列に対応する自動実行ルールをProjectで用意します。

```python
client = mlflow.MlflowClient()
client.create_registered_model("qwen3", tags={"mmt.model_family": "qwen3"})
```

`mmt.code_version_id`で既定のCodeVersionを指定できます。モデル本体のArtifactが複数候補に当てはまる場合は、`mmt.weights_path`でモデル内の相対pathを指定します。モデルと実行コードの系列・Projectの対応は既存の検証を通ります。登録済み版の実行設定はtagを書き換えて変更できません。

複数ファイルを使うモデルは、`MLmodel`のflavorが示す保存済みディレクトリをモデル本体として扱います。この場合のモデル版は`MLmodel`と一式のArtifactを保持します。推論コードでは`mlflow.pyfunc.load_model()`で版を読み込んでください。単一の重みファイルを読むコードには`mmt.weights_path`を明示します。Hugging Face・TensorFlowなどの実モデルでの確認は別途必要です。

## モデルを評価する

`mlflow.models.evaluate`の結果はRunとLogged Modelの両方に記録されます。登録モデルの自動評価ルールから起動したJobでも、評価コードはそのまま使えます。

```python
import mlflow

with mlflow.start_run():
    result = mlflow.models.evaluate(
        "models:/regression@candidate",
        reference_rows,  # 特徴量と正解列を持つpandas.DataFrame
        targets="target",
        model_type="regressor",
        evaluators=["default"],
    )
```

既定の評価器は、行ごとのscoreを返すmetricがあるときだけ`eval_results_table.json`を保存します。回帰の組み込みmetricだけでは表は作られません。行ごとの結果を残したい場合は、`mlflow.models.make_metric`で`MetricValue(scores=...)`を返すmetricを`extra_metrics`に加えてください。例は`python/examples/mlflow_evaluation.py`です。

自動評価のJobでは、`mlflow.start_run()`がJobのRunに接続するので、評価結果は新しいRunを作らずにJobのRunへ入ります。評価するモデル版はworkerが渡す`MMT_MODEL_VERSION_FILE`から読み、`mlflow-artifacts:/model-versions/<版のID>/artifacts`で読み込みます。この版の`metadata.mlflow.loggedModelId`を`model_id`に渡すと、metricsが元のLogged Modelにも付きます。公式SDKの`MlflowClient.get_model_version()`は応答の`model_id`を捨てるため（SDKの`ModelVersion.from_proto`の未実装）、SDKの版オブジェクトからは取れません。

公式SDKの`evaluate()`は、評価器の中で1回、終了時に`model_id`付きでもう1回、同じmetricを送ります（`mlflow/models/evaluation/base.py`）。このため各metricの履歴には同じ値が2点、timestampを変えて残ります。最新値は同じなので、比較や一覧の表示には影響しません。

## 表・画像・音声のArtifactを記録する

`log_table`・`log_image`（`artifact_file`を指定する形式）・`log_dict`（JSON・YAML）・`log_text`・`log_figure`は、通常のArtifactとして保存し、一覧・ダウンロードできます。`log_table`がRunに付ける`mlflow.loggedArtifacts`タグも保存します。

音声ファイルは`mlflow.log_artifact`で保存します。SDKはPythonの`mimetypes`で判定したContent-Typeを送り、サーバーはその値をそのまま保存して返します。手元の確認ではwavが`audio/x-wav`、flacが`audio/flac`でした。SDKが`application/octet-stream`を送った場合（`mimetypes`が拡張子を知らない環境）は、拡張子から`audio/wav`や`audio/flac`を推定します。Range要求には206で一部だけを返すので、プレイヤーのシークに使えます。nativeのcontent URL（`GET /projects/:p/artifacts/:a/content`）も、MLflowから保存した音声を同じContent-Typeのままinline・Range対応で返します。

`log_image(image, key=..., step=...)`で記録した画像は、通常のArtifactとして保存したうえで、Runのmediaとしてkeyとstepで引けるようにします（nativeの`GET /api/projects/:p/runs/:r/media?key=...`、step順）。公式SDKが同じ呼び出しで保存する縮小版（`compressed.webp`）は、同じ項目のthumbnailになります。ファイル名の形式はSDKの版で違い、3.0.0は`images/<key>%step%<step>%timestamp%<ms>%<uuid>.png`、3.17.0以降は`images/<key>+step+<step>+timestamp+<ms>+<uuid>.png`です。どちらも読みます。

MLflow 3.0.0のSDKは、keyの`/`を`#`に置き換えたままURLへ載せるため、`#`より後ろが送られずファイル名が切れます。3.0.0では`/`を含まないkey（`eval_mel`など）を使ってください。3.17.0以降は`/`を`~`にするので問題ありません。

`log_table`の表は、Runの`mlflow.loggedArtifacts`タグに載ったものをstep 0の表としてmediaの一覧に出します。表APIは`orient='split'`のJSON（`log_table`の既定）を読み、画像の列（`{type:'image', filepath, compressed_filepath}`）を保存済みのArtifactに解決します。parquetで保存した表は表示できません（422 `unsupported_table_format`）。50MiBを超える表はAPIで頁送りせず、Artifactをダウンロードして開きます。

この機能より前に保存した画像は、`npm run backfill-run-media`で索引できます。何度実行しても増えません。multipart uploadで保存した画像（既定では500MiB以上）は保存時には索引せず、backfillで入ります。

## 自作のpyfuncモデルを登録する

`mlflow.pyfunc.PythonModel`を継承したモデルを、複数のファイルやディレクトリを`artifacts`に指定して保存できます。登録した版は`models:/名前@alias`で読み込めます。`mlflow.artifacts.download_artifacts("models:/名前@alias")`は、`MLmodel`・`python_model.pkl`と、指定したファイル・ディレクトリの全体を元のbytesのまま返します。

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

SDKからはAPI tokenを`MLFLOW_TRACKING_TOKEN`（Bearer）で渡します。ユーザー名とパスワードしか設定できない社内ツールでは、Basic認証も使えます。passwordにAPI tokenを入れ、ユーザー名は任意の値にします（照合しません）。

```bash
export MLFLOW_TRACKING_URI="https://tracking.example.internal/api/mlflow/projects/<project-uuid>"
export MLFLOW_TRACKING_USERNAME=mado
read -r -s -p 'API token: ' MLFLOW_TRACKING_PASSWORD
export MLFLOW_TRACKING_PASSWORD
```

- Basic認証が使えるのはMLflow互換API（`/api/mlflow/*`）だけです。native APIは401 `basic_auth_unsupported`。
- passwordにローカルアカウントのパスワードを入れても通りません（401）。
- 失効・scope・Projectの権限の確認はBearerと同じです。Job限定token（`mmtj_`）をpasswordにしても、Job tokenの許可表がそのまま効きます。
- tokenを発行した直後の画面に、Bearer／Basicそれぞれの環境変数の設定例が出ます。
- 設定画面「MLflow 3から接続」の折りたたみにも、Basic認証の設定例があります。

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

workerはPython・Docker・Singularity・Apptainerの実行環境にMLflowの接続先・token・Experiment ID・Run IDを渡します。tokenはそのRunに関わる記録だけを書けるJob限定tokenです（[worker手順](worker.md#実行コードにはjob限定tokenを渡す)）。PythonのrequirementsまたはコンテナにMLflow 3を含めてください。記録コードの`mlflow.start_run()`はJobが使用するRunに接続します。

Jobの終了はworkerが管理します。SDKの`end_run()`が呼ばれても、子プロセスが動いている間はJobとRunを完了しません。プロセスの終了、出力の回収、停止確認を終えた後にworkerが最終状態を確定します。実行条件の既存paramsを違う値で書き換えることはできません。

JobのRunに追加したSDKのparamsは記録用の`recordedParameters`へ保存し、画面やSDKでは実行paramsと合わせて表示します。workerが再接続・再実行で使う実行条件を変更しません。

## 公式SDKでの確認状況

`scripts/verify_mlflow3.py`で、MLflow 3.0.0（scikit-learn 1.6.1）と3.17.0（scikit-learn 1.9.1）の両方を実HTTPで確認した範囲です（2026-10-08）。この表にない機能は未確認です。

| 機能 | 結果 | 確認した内容 |
| --- | --- | --- |
| Run・nested Run・params・metrics・tags | 対応 | 記録、paramsの上書き拒否、metric履歴、検索、削除と復元 |
| Artifactの転送 | 対応 | 6MiB・空ファイル・日本語pathのアップロードとダウンロード、hashの一致 |
| multipart upload（`mpu/*`） | 対応 | 3.17.0はserver-infoから自動で、3.0.0は`MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true`で、5MiBのchunk2個に分けて送信。両方のserver-infoのpath、downloadのhash一致 |
| Logged Model・Model Registry・alias | 対応 | sklearnモデルの保存と読み込み、版の登録、`models:/名前@alias`の読み込み |
| scikit-learn autolog | 対応 | params・metrics・入力Dataset・Logged Modelの自動記録 |
| `mlflow.models.evaluate` | 対応 | RunとLogged Modelへのmetrics、`eval_results_table.json`の保存と一覧 |
| 登録をきっかけにした自動評価 | 対応 | モデル版の登録からCPUのJobで`evaluate()`を実行し、実行記録が1件、評価結果がJobのRunだけに入る |
| `log_table`・`log_image`・`log_dict`・`log_text`・`log_figure` | 対応 | 一覧、ダウンロードした内容、PNGのContent-Type |
| 音声Artifact（wav・flac） | 対応 | Content-Typeの保持、Range要求の206、nativeのinline表示 |
| `log_image(key=, step=)`・`log_table`（画像列）のmedia索引 | 対応 | `scripts/mlflow3_checks/media_steps.py`。3 stepの画像がstep順に3件・thumbnail付きで並び、表の画像セルがArtifactに解決される（3.0.0はkeyに`/`を含めない） |
| 自作pyfunc・複数ファイルのモデル | 対応 | alias経由の読み込みと予測値の一致、`download_artifacts("models:/名前@alias")`で全ファイルのhashが一致 |
| `mlflow.search_runs`のpandas出力 | 対応 | `run_id`・`params.*`・`metrics.*`・`tags.*`・`status`の列 |
| webhooks（`create_webhook`など） | 未対応 | 3.17.0は404 `ENDPOINT_NOT_FOUND`の`MlflowException`になる。3.0.0のSDKにはAPIがない |
| Tracing（`search_traces`、`@mlflow.trace`） | 未対応 | `search_traces`は404 `ENDPOINT_NOT_FOUND`の`MlflowException`になる。`@mlflow.trace`を付けた関数は結果を返し、Runも正常に終わる。traceの送信失敗はSDKが警告のログを出すだけ |

`mlflow.models.evaluate`（回帰）とsklearn autologは、どちらの版でもTracingのAPI（`/api/2.0/mlflow/traces`・`/api/3.0/mlflow/traces`）を呼びませんでした。Tracingを使うコードを動かした場合も、上の表のとおり学習・評価は止まりません。

MLflow UIが図の間引きに使う`ajax-api/2.0/mlflow/metrics/get-history-bulk-interval`は実装していません。公式SDKはこのAPIを呼びません。同じ目的にはnativeの`POST /api/projects/:p/metrics/series`（等幅bucketの平均・min・max、x軸 step / relative_time / wall_time / metric）を使います。`get-history`の頁送りは変えていません。

## 検証する

開発API/Webとlocal executorを起動し、公式SDKを入れたPython環境で実行します。

```bash
uv venv --python 3.13 artifacts/verification/mlflow3-venv
uv pip install --python artifacts/verification/mlflow3-venv/bin/python \
  'mlflow==3.17.0' 'scikit-learn==1.9.1' -e ./python
artifacts/verification/mlflow3-venv/bin/python scripts/verify_mlflow3.py
```

検証は、`/server-info`と`/api/3.0/mlflow/server-info`の両方が`multipart_uploads_enabled: true`を返すことと、6MiBを少し超えるファイルの`log_artifact`がmultipart uploadを通ることを確かめます。検証中だけSDKの`MLFLOW_MULTIPART_UPLOAD_MINIMUM_FILE_SIZE`を1MiB、`MLFLOW_MULTIPART_UPLOAD_CHUNK_SIZE`を5MiBにし、part PUTが2回で通常のPUTが無いこと、一覧のsizeとdownloadのSHA-256が一致することを見ます。3.0のSDKはserver-infoを読まないので、検証が`MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true`を付けます。

開発用DBを使わずに確かめるときは、テスト専用DBで検証用APIを起動して`MMT_VERIFY_API_URL`で指定します。検証用APIはupload finalizerも動かし、`mpu`のrequestをmethod・path・statusだけ1行ずつ標準出力へ書きます。

```bash
MMT_VERIFY_API_PORT=47070 MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55490/mmt_test \
  npx tsx scripts/serve_mlflow_verification.ts
MMT_VERIFY_API_URL=http://127.0.0.1:47070 artifacts/verification/mlflow3-venv/bin/python scripts/verify_mlflow3.py
```

検証用Project・token・CPU target・自動実行ルールを作り、終了時にtokenを失効しルールを無効化します。Runとモデルは確認用に残します。結果は`artifacts/verification/<日付>/mlflow3/sdk-integration.json`へ保存します。

確認の処理は`scripts/mlflow3_checks/`に分けています。`evaluation.py`が評価と自動評価、`rich_artifacts.py`が表・画像・音声、`pyfunc_model.py`が自作pyfuncとsearch_runs、`common.py`が共通の部品です。自動評価の確認では`python/examples/mlflow_evaluation.py`をそのまま評価コードとして登録して動かします。`rich_artifacts.py`は`matplotlib`・`pandas`・`PyYAML`・`Pillow`を使います。どれも`mlflow`（skinnyではない方）を入れると一緒に入ります。

stepごとのmediaは単独の`scripts/mlflow3_checks/media_steps.py`で確かめます。テスト専用DBの検証用APIへ記録し、結果を`artifacts/verification/<日付>/media-steps/mlflow-<版>.json`へ保存します。

```bash
MMT_VERIFY_API_PORT=47080 MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55490/mmt_test \
  npx tsx scripts/serve_mlflow_verification.ts
<MLflow 3.0.0 または 3.17.0 の venv>/bin/python scripts/mlflow3_checks/media_steps.py \
  --mado-api-url http://127.0.0.1:47080
```

この検証は公式SDKとHTTP APIの互換性を確かめます。実SSH/GPU、Authentik、実S3の接続確認は別途行います。
