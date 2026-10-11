---
title: モデルとバージョン
description: モデル、バージョン、モデル系列、Aliasの考え方と登録方法。バージョンの自動採番と、学習Runから推論・評価までのLineage。
---

# モデルとバージョン

![モデルとバージョンの一覧](/images/models-registry.png)

Modelsの［モデルとバージョン］では、学習した重みをモデルのバージョンとして登録し、Aliasで「今使うバージョン」を指します。バージョンは登録した後に変更できないため、どのRunがどの重みで推論・評価したかを後から確かめられます。

## こんなときに向いています

- 学習Runが出力した重みを、どの学習から作ったかと一緒に残したい
- 推論や評価のコードから、バージョン番号ではなく`production`のようなAliasでモデルを指定したい
- 新しいバージョンを登録したら、推論と評価を自動で回したい（[モデル登録後の自動実行](/models/automation)）
- 本番のバージョンを、評価の結果を確かめてから切り替えたい（[評価の比較と昇格](/models/promotion)）

## モデル、バージョン、系列、Alias

| 用語 | 内容 |
| --- | --- |
| モデル | バージョンをまとめる名前です。名前、モデル系列、説明を持ちます。名前と系列は登録後に変更できません |
| バージョン | 1回分の学習結果です。重み（ArtifactまたはURI）、生成元Run、親のバージョン、既定のコードバージョン、Metadataを持ちます。登録後に変更できません |
| モデル系列 | モデルの構造の種類を表す文字列です（例:`qwen3`、`linear`）。コードバージョンの［対応モデル系列］、自動実行ルールの［対象モデル系列］と照合し、構造の合わないコードでモデルを動かさないようにします |
| Alias | バージョンを指す名前です（例:`production`、`candidate`）。いつ、誰が、どのバージョンからどのバージョンへ変えたかを履歴に残します |

バージョンの項目は次のとおりです。

- 生成元Run: 重みを作った学習Run。バージョンの詳細画面から学習の記録へ移動できます。
- 親のバージョン: fine-tuningの元にしたバージョン。同じ系列のバージョンだけを選べます。
- 重みのArtifact、重みのURI: バージョンの重みの場所。workerは推論・評価の実行前にここから重みを取得します。
- 既定のコードバージョン: このバージョンを動かすときに既定で使うコードバージョン。バージョンの系列に対応するコードバージョンだけを選べます。

## モデルを登録する

権限はProjectのeditor以上です。API tokenで登録する場合は`registry:write` scopeが必要です。

1. Modelsを開き、［モデルを登録］を押します。
2. ［名前］にモデル名、［モデル系列］に系列を入力します。例:名前`voice-tts`、系列`linear`。系列は、使うコードバージョンの［対応モデル系列］と同じ文字列にします。
3. ［保存］を押し、左の一覧に追加されたことを確かめます。

## バージョンを登録する

バージョンを登録する方法は5つあります。学習から登録までを自動にするなら、Taskの出力設定か学習コードでの登録を使います。

| 方法 | バージョン名 | 向いている場面 |
| --- | --- | --- |
| 画面の［バージョンを作成］ | 入力が必要 | 外部で作った重みを手で登録する |
| [Taskの出力モデル設定](/models/tasks#register-a-model-when-training-succeeds) | 自動採番（バージョン名のテンプレートも指定可） | 学習コードを変えずに、成功した学習の重みを登録する |
| Python SDKの`register_output_model()` | 省略すると自動採番 | 学習コードの中で登録する |
| MLflowの`register_model()`、`log_model(registered_model_name=…)` | 自動採番 | MLflow 3 SDKで学習を記録している |
| コンテナの`result.json`（version 2）の`models` | 自動採番 | SDKを入れていないコンテナで学習する |

### 画面から登録する

1. 左の一覧でモデルを選び、右上の［バージョンを作成］を押します。
2. ［バージョン］にバージョン名を入力します。例:`3`。画面からの登録ではバージョン名を省略できません。
3. ［生成元Run］で学習Runを選び、重みのArtifactのIDを［Artifact ID］に入力するか、［重みのURI］を入力します。ArtifactのIDは、学習RunのArtifactsタブで重みのファイルを開くと表示されます。
4. 必要なら［親のバージョン］と［既定のコードバージョン］を選び、［保存］を押します。
5. バージョンの一覧に新しい行が追加され、［最新のバージョン］が変わったことを確かめます。

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
        print(version["version"])  # 自動採番されたバージョン名（例: 3）
```

MLflow 3 SDKで登録する場合は、登録したモデルのtag`mmt.model_family`に系列を指定します。接続方法は[MLflow 3 SDKで記録する](/tracking/mlflow)を参照してください。

```python
version = mlflow.register_model(recorded.model_uri, "voice-tts")
loaded = mlflow.pyfunc.load_model("models:/voice-tts@production")
```

## バージョンの自動採番

バージョン名を省略すると、モデルごとに`1`、`2`、`3`…と整数で採番します。MLflowの採番と同じ規則です。

- 画面、Python SDK、MLflow、Task、`result.json`のどこから登録しても、同じモデルの番号は1つの連番になります。交互に登録しても重複しません。
- 削除したバージョンの番号は再利用しません。
- `10`のように整数のバージョン名を指定して登録すると、次の採番は`11`から始まります。
- `v1`のような整数でないバージョン名と、19桁以上の数字のバージョン名は採番の計算に含めません。整数でないバージョン名の既存のバージョンは、そのまま残ります。
- 同じバージョン名をもう一度指定すると、登録を拒否します（409）。

## Aliasを設定する

![Aliasの設定（昇格）ダイアログ](/images/models-promotion-dialog.png)

1. 左の一覧でモデルを選び、［Aliasを設定］を押します。
2. ［Alias］にAlias名、［バージョン］に指すバージョンを指定します。例:Alias`production`、バージョン`3`。
3. ［理由］に切り替えの理由を入力し、［保存］を押します。理由は任意ですが、保護Aliasでは必要になる場合があります。
4. Aliasの一覧で、Aliasが指定したバージョンを指していることを確かめます。

Aliasを外すときは、Aliasの一覧の［Aliasを解除］を押します。解除も履歴に残ります。

推論や評価のRunを起動するときにAliasを指定しても、Runに保存されるのはその時点でAliasが指していたバージョンです。後でAliasを別のバージョンへ移しても、過去のRunの記録は変わりません。

［Aliasの履歴］では、日時、旧バージョンと新バージョン、操作者、経路（Web、API、MLflow、昇格policy、バージョンの削除、モデルの削除）を新しい順に確認できます。履歴は追記だけで、変更や削除はできません。

`production`のような重要なAliasは、変更できる人と条件を絞れます。設定は[評価の比較と昇格](/models/promotion#protect-an-alias)を参照してください。

## バージョンの詳細を見る

![バージョンの詳細画面](/images/models-version.png)

バージョンの一覧でバージョンを選び、［バージョンの詳細画面を開く］を押すと、バージョンの詳細画面が開きます。

- ［学習Run → バージョン → 推論・評価Run］: バージョンを作った学習Runと、そのバージョンで動いた推論・評価Runを1本の図で表示します。新しい順に最大20件です。
- ［自動実行］: このバージョンをきっかけに動いた自動実行の履歴です。
- ［評価結果］: 成功した評価Runの指標の最新値と、基準バージョンとの比較です（[評価の比較と昇格](/models/promotion)）。
- ［昇格の判定］: 昇格policyによる、このバージョンの合否です。

## Lineageで関係をたどる

![Lineage画面](/images/models-lineage.png)

Lineageでは、Project内のデータセットバージョン、Run、MLflow記録モデル、モデルバージョン、コードバージョンの関係を1つの図で表示します。どのデータで学習したバージョンか、どのバージョンがどの推論出力を作ったかを、左から右へたどれます。

つながりの種類は、データ入力、データ出力、モデル入力、モデル出力、モデル登録、親モデル、親データセット、親Run、実行コードです。図の下の［関係］を開くと、つながりを表で確認できます。

## 権限

| 操作 | 必要な権限 |
| --- | --- |
| 一覧・バージョンの詳細・Lineageを見る | viewer以上 |
| モデル・バージョンの登録、Aliasの設定と解除 | editor以上（API tokenは`registry:write`） |
| 保護Aliasの変更 | 保護の設定による（[保護Alias](/models/promotion#protect-an-alias)） |

## 次に読む

- [Taskとコードバージョン](/models/tasks)で、学習の成功時にバージョンを登録する設定を作ります。
- [モデル登録後の自動実行](/models/automation)で、登録したバージョンの推論と評価を自動で回します。
