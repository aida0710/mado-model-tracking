# MLflow 3 tracking API

`mlflowTrackingRoutes({database,runs,registry})`を、認証middlewareの後で
`/api/mlflow/projects/:p`へmountする。対応基準は公式SDK 3.17.0のservice descriptorとrest_store。
SDKのREST pathには`/api/2.0/mlflow`が含まれる。

ExperimentとRunはnativeのUUIDをIDとして返す。既定Experiment ID `0`は、Project内のnative
`Default` Experimentへの入口として扱う。Run作成時にDefaultが未作成なら登録する。
空のアプリに対する`set_experiment("名称")`の登録・取得に対応する。
引数なしの`set_experiment()`と空文字の名称は公式SDK自身の検証で拒否される。

## 保存と認可

読む操作にはProject viewerと`read`、Run/Experimentを書く操作にはeditorと`runs:write`が必要。
Dataset入力の新規native版の登録には、既存Registryと同じ`registry:write`も要求する。
登録済みDatasetの入力追加には`runs:write`を使う。

Run parametersはstringで不変。同じ値の再送は成功する。
Job管理Runは実行設定の`parameters`を変更せず、SDKで記録した値を`recorded_parameters`へ保存する。
SDKのRunDataとparams検索は両方を合成する。native APIは両mapを分けて返し、workerのclaim/resumeは
元の実行設定を保持する。pinned値の数値・真偽値・nullは、Python SDKの`True`/`False`/`None`表現も同値判定し、SDKのstringを記録mapへ保持する。

Job管理RunへのSDKのRUNNING更新とFINISHED/FAILED/KILLED更新は成功する。
状態と開始・終了時刻はworkerが管理し、SDK操作では変更しない。SDKには現在のRunInfoを返す。
JobがないRunは同じIDで終了・resumeでき、resume時に終了時刻を消す。

`mlflow.runName`と`mlflow.parentRunId`をnative名称・親Runへ同期する。
同じProject・Experiment内のactive親Runだけを受け付け、同時編集でも循環参照を拒否する。

metricsはsigned int64のstep、millisecond timestamp、値とDataset/Model文脈を保持する。
最新値はstep、timestamp、valueの降順。同じSDK pointのretryは重複しない。
大きいint64はprotobuf JSONのstring形式で返して桁を保持する。
log-batchはparams・tags・metricsとモデルmetricsを同じtransactionへ保存し、失敗したbatchを残さない。
get/searchも同じ保存時点からmetadata・metrics・入出力を返す。

記録時はExperiment、Run、モデルの順にlockを取る。RunにはFOR NO KEY UPDATEを使い、
Registryが版を登録する際のRun FK KEY SHAREと両立させる。
Artifactのsource Runとモデルの同時転送・出力記録も同じ順で処理する。

Datasetのdigest・source・schema・profile・contextは補助tableとnative DatasetVersionへ保存し、
Run.inputDatasetVersionIdsに結び付ける。source URLのサーバー側fetchは行わない。
モデル入力・出力は同Projectの非削除Logged Modelへ結び、出力のsource_run_id一致を検証する。
モデル付きmetricsは006のmlflow_logged_model_metricsへも保存する。

## 検索と削除

検索はANDによる条件結合に対応する。文字列は`=`/`!=`/`LIKE`/`ILIKE`、metricsと時刻は数値比較、
params/tagsは`IS NULL`/`IS NOT NULL`、run_idとDataset属性は`IN`/`NOT IN`に対応する。
引用符付きのkey・値を受け付け、SQLには値とJSON keyをすべてパラメータで渡す。
Runのorder_byはattributes/metrics/params/tags、Experimentはattributesを扱い、欠落値は最後へ置く。
pagination tokenにはProject・条件・並べ替えを含むfingerprintを保存し、別条件への流用を拒否する。

metricのNaNは数値比較の`!=`だけに一致する。昇順・降順とも数値、NaN、未記録の順に並ぶ。
Experiment改名はArtifact PUTと同じProject→Experimentの順でlockを取得する。

Run/Experimentはsoftdeleteし、native一覧にも反映する。Experiment restoreは配下Runも復元する。
実行中Jobを含むRun/Experimentの削除は拒否する。
任意artifact_location、OR、未知の属性・演算子などは明示エラーを返す。
legacy log-modelはRunのmlflow.log-model.historyタグを保持する。

## 担当検証

専用のloopback mmt_test DBへ各harnessが隔離schemaを作る。
dev DBや外部MLflowは使用しない。

```bash
cd apps/api
MMT_TEST_DATABASE_URL=postgresql://mmt@127.0.0.1:55483/mmt_test \
  ../../node_modules/.bin/vitest run test/mlflow-tracking.integration.test.ts
```

担当テストは認可、版とJob実行設定の保持、競合、保存失敗、retry、検索・paginationと実SDK protobufによるデコードを検証する。
全体の外部HTTP SDK試験、UI確認、commitは親担当が実施する。
