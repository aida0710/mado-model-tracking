---
title: モデルと版
description: モデル、版、モデル系列、Aliasの考え方と登録方法。版の自動採番と、学習Runから推論・評価までのLineage。
---

# モデルと版

![モデルと版の一覧](/images/models-registry.png)

Modelsの［モデルと版］では、学習した重みをモデルの版として登録し、Aliasで「今使う版」を指します。版は登録した後に変更できないため、どのRunがどの重みで推論・評価したかを後から確かめられます。

## こんなときに向いています

- 学習Runが出力した重みを、どの学習から作ったかと一緒に残したい
- 推論や評価のコードから、版番号ではなく`production`のようなAliasでモデルを指定したい
- 新しい版を登録したら、推論と評価を自動で回したい（[モデル登録後の自動実行](/models/automation)）
- 本番の版を、評価の結果を確かめてから切り替えたい（[評価の比較と昇格](/models/promotion)）

## モデル、版、系列、Alias

| 用語 | 内容 |
| --- | --- |
| モデル | 版をまとめる名前です。名前、モデル系列、説明を持ちます。名前と系列は登録後に変更できません |
| 版 | 1回分の学習結果です。重み（ArtifactまたはURI）、生成元Run、親の版、既定のコード版、Metadataを持ちます。登録後に変更できません |
| モデル系列 | モデルの構造の種類を表す文字列です（例:`qwen3`、`linear`）。コード版の［対応モデル系列］、自動実行ルールの［対象モデル系列］と照合し、構造の合わないコードでモデルを動かさないようにします |
| Alias | 版を指す名前です（例:`production`、`candidate`）。いつ、誰が、どの版からどの版へ変えたかを履歴に残します |

版の項目は次のとおりです。

- 生成元Run: 重みを作った学習Run。版の詳細画面から学習の記録へ移動できます。
- 親の版: fine-tuningの元にした版。同じ系列の版だけを選べます。
- 重みのArtifact、重みのURI: 版の重みの場所。workerは推論・評価の実行前にここから重みを取得します。
- 既定のコード版: この版を動かすときに既定で使うコード版。版の系列に対応するコード版だけを選べます。

## モデルを登録する

権限はProjectのeditor以上です。API tokenで登録する場合は`registry:write` scopeが必要です。

1. Modelsを開き、［モデルを登録］を押します。
2. ［名前］にモデル名、［モデル系列］に系列を入力します。例:名前`voice-tts`、系列`linear`。系列は、使うコード版の［対応モデル系列］と同じ文字列にします。
3. ［保存］を押し、左の一覧に追加されたことを確かめます。

## 版を登録する

版を登録する方法は5つあります。学習から登録までを自動にするなら、Taskの出力設定か学習コードでの登録を使います。

| 方法 | 版名 | 向いている場面 |
| --- | --- | --- |
| 画面の［版を作成］ | 入力が必要 | 外部で作った重みを手で登録する |
| [Taskの出力モデル設定](/models/tasks#register-a-model-when-training-succeeds) | 自動採番（版名のテンプレートも指定可） | 学習コードを変えずに、成功した学習の重みを登録する |
| Python SDKの`register_output_model()` | 省略すると自動採番 | 学習コードの中で登録する |
| MLflowの`register_model()`、`log_model(registered_model_name=…)` | 自動採番 | MLflow 3 SDKで学習を記録している |
| コンテナの`result.json`（version 2）の`models` | 自動採番 | SDKを入れていないコンテナで学習する |

### 画面から登録する

1. 左の一覧でモデルを選び、右上の［版を作成］を押します。
2. ［版］に版名を入力します。例:`3`。画面からの登録では版名を省略できません。
3. ［生成元Run］で学習Runを選び、重みのArtifactのIDを［Artifact ID］に入力するか、［重みのURI］を入力します。ArtifactのIDは、学習RunのArtifactsタブで重みのファイルを開くと表示されます。
4. 必要なら［親の版］と［既定のコード版］を選び、［保存］を押します。
5. 版の一覧に新しい行が追加され、［最新の版］が変わったことを確かめます。

### 学習コードから登録する

Python SDKでは、学習Runの中で重みを保存して登録します。`model_name`に指定したモデルが無ければ、`family`の系列で作成します。

```python
from mado_tracking import Client

with Client() as client:
    with client.start_run(
        project_id="<project-uuid>",
        experiment_id="<experiment-uuid>",
        name="train-v3",
        kind="training",
    ) as run:
        ...  # 学習して weights.bin を保存する
        artifact = run.log_artifact("weights.bin", path="model/weights.bin")
        version = run.register_output_model(
            model_name="voice-tts", family="linear", artifact_id=artifact["id"],
        )
        print(version["version"])  # 自動採番された版名（例: 3）
```

MLflow 3 SDKで登録する場合は、登録したモデルのtag`mmt.model_family`に系列を指定します。接続方法は[MLflow 3 SDKで記録する](/tracking/mlflow)を参照してください。

```python
version = mlflow.register_model(recorded.model_uri, "voice-tts")
loaded = mlflow.pyfunc.load_model("models:/voice-tts@production")
```

## 版の自動採番

版名を省略すると、モデルごとに`1`、`2`、`3`…と整数で採番します。MLflowの採番と同じ規則です。

- 画面、Python SDK、MLflow、Task、`result.json`のどこから登録しても、同じモデルの番号は1つの連番になります。交互に登録しても重複しません。
- 削除した版の番号は再利用しません。
- `10`のように整数の版名を指定して登録すると、次の採番は`11`から始まります。
- `v1`のような整数でない版名と、19桁以上の数字の版名は採番の計算に含めません。整数でない版名の既存の版は、そのまま残ります。
- 同じ版名をもう一度指定すると、登録を拒否します（409）。

## Aliasを設定する

![Aliasの設定（昇格）ダイアログ](/images/models-promotion-dialog.png)

1. 左の一覧でモデルを選び、［Aliasを設定］を押します。
2. ［Alias］にAlias名、［版］に指す版を指定します。例:Alias`production`、版`3`。
3. ［理由］に切り替えの理由を入力し、［保存］を押します。理由は任意ですが、保護Aliasでは必要になる場合があります。
4. Aliasの一覧で、Aliasが指定した版を指していることを確かめます。

Aliasを外すときは、Aliasの一覧の［Aliasを解除］を押します。解除も履歴に残ります。

推論や評価のRunを起動するときにAliasを指定しても、Runに保存されるのはその時点でAliasが指していた版です。後でAliasを別の版へ移しても、過去のRunの記録は変わりません。

［Aliasの履歴］では、日時、旧版と新版、操作者、経路（Web、API、MLflow、昇格policy、版の削除、モデルの削除）を新しい順に確認できます。履歴は追記だけで、変更や削除はできません。

`production`のような重要なAliasは、変更できる人と条件を絞れます。設定は[評価の比較と昇格](/models/promotion#protect-an-alias)を参照してください。

## 版の詳細を見る

![版の詳細画面](/images/models-version.png)

版の一覧で版を選び、［版の詳細画面を開く］を押すと、版の詳細画面が開きます。

- ［学習Run → 版 → 推論・評価Run］: 版を作った学習Runと、その版で動いた推論・評価Runを1本の図で表示します。新しい順に最大20件です。
- ［自動実行］: この版をきっかけに動いた自動実行の履歴です。
- ［評価結果］: 成功した評価Runの指標の最新値と、基準版との比較です（[評価の比較と昇格](/models/promotion)）。
- ［昇格の判定］: 昇格policyによる、この版の合否です。

## Lineageで関係をたどる

![Lineage画面](/images/models-lineage.png)

Lineageでは、Project内のデータセット版、Run、MLflow記録モデル、モデル版、コード版の関係を1つの図で表示します。どのデータで学習した版か、どの版がどの推論出力を作ったかを、左から右へたどれます。

つながりの種類は、データ入力、データ出力、モデル入力、モデル出力、モデル登録、親モデル、親データセット、親Run、実行コードです。図の下の［関係］を開くと、つながりを表で確認できます。

## 権限

| 操作 | 必要な権限 |
| --- | --- |
| 一覧・版の詳細・Lineageを見る | viewer以上 |
| モデル・版の登録、Aliasの設定と解除 | editor以上（API tokenは`registry:write`） |
| 保護Aliasの変更 | 保護の設定による（[保護Alias](/models/promotion#protect-an-alias)） |

## 次に読む

- [Taskとコード版](/models/tasks)で、学習の成功時に版を登録する設定を作ります。
- [モデル登録後の自動実行](/models/automation)で、登録した版の推論と評価を自動で回します。
