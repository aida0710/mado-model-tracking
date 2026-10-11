---
title: クイックスタート
description: 最初のProjectを作り、Python SDKと公式MLflow 3 SDKでRunを記録して画面で確かめる。モデルの登録から自動評価までを試す手順も示す。
---

# クイックスタート

最初のProjectと実験を作り、Python SDKと公式のMLflow 3 SDKで学習のRunを記録します。最後に、モデルを登録して推論と評価を自動で回すまでの手順を示します。

サーバーは[インストール](/guide/install)の手順で起動済みとします。以下の`https://tracking.example.com`は、実際の`MMT_PUBLIC_URL`に読み替えてください。

## 1. Projectを作る

ブラウザで`MMT_PUBLIC_URL`を開いてログインします。初期管理者で初めてログインしたときは、パスワードの変更を求められます。

見られるProjectがまだ無いと、「プロジェクト」の画面が表示されます。［プロジェクトを作成］を押し、次の値を入力して［作成］を押します。ほかのProjectが既にあるときは、サイドバーの上にあるProjectの名前を押して切り替えを開き、一番下の［＋ プロジェクトを作成］を押します。

| 項目 | 入力する値の例 |
| --- | --- |
| 名前 | `音声認識の実験` |
| 説明（任意） | 空欄でかまいません |
| 公開範囲 | 既定の「Public」（ログインできる全員が使えます）。メンバーだけで使うなら「Private」 |
| Artifact保存先 | 既定のまま（全体管理者が設定した保存先） |

作成したProjectのExperimentsの画面に移れば完了です。作成者はそのProjectのAdminになります。Projectの切り替えや公開範囲は、[Projectの作成と管理](/admin/projects)を参照してください。

![名前、説明、公開範囲、Artifact保存先を入力するプロジェクトの作成画面](/images/guide-projects.png)

## 2. 実験を作る

［Experiments］の左側にある［＋］（実験を作成）を押し、名前に`whisper-small-finetune`と入力して［保存］を押します。

左側の一覧で作った実験を選ぶと、名前の下に`ID`が表示されます。Python SDKではこの実験IDを使うので控えておきます。ProjectのIDは、ブラウザのURLの`/projects/`の後ろの部分です。

## 3. API tokenを発行する

SDKからの記録には、ログインのパスワードではなくAPI tokenを使います。

1. サイドバーの［プロジェクト設定］を開き、「MLflow 3から接続」の［このProject用のAPI tokenを発行］を押します。
2. 名前に`laptop-sdk`のように用途が分かる名前を入力します。
3. Scopeは`read`、`runs:write`、`registry:write`、`artifacts:write`が選ばれた状態になっています。そのままにします。
4. 有効期限を選んで［保存］を押します。

![名前、Scope、有効期限を入力するAPI tokenの発行画面](/images/guide-token-dialog.png)

tokenの値は一度だけ表示されます。閉じる前にコピーし、パスワードマネージャーなど安全な場所へ保存してください。tokenは発行したProjectだけで使えます。

## 4. Python SDKで記録する

記録するマシンのターミナルで、Python 3.11以上の仮想環境を作ってSDKを入れます。Ubuntuでは先に`python3-venv`と`git`を入れておきます。

```sh
sudo apt install -y python3-venv git
python3 -m venv ~/.venvs/mmt
~/.venvs/mmt/bin/pip install 'mado-tracking @ git+https://github.com/aida0710/mado-ml-tracking.git#subdirectory=python'
```

接続先とtokenを環境変数に設定します。tokenは画面に表示されない入力で渡し、ソースコードやシェルの履歴に残さないでください。

```sh
export MMT_API_URL=https://tracking.example.com
read -r -s -p 'API token: ' MMT_API_TOKEN
export MMT_API_TOKEN
```

次の内容を`train_sdk.py`として保存します。`PROJECT_ID`と`EXPERIMENT_ID`は、手順1と2で控えた値に置き換えます。

```python
import math

from mado_tracking import start_run

PROJECT_ID = "<ProjectのID>"
EXPERIMENT_ID = "<実験のID>"

with start_run(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID, name="lr-1e-4") as run:
    run.log_params({"learning_rate": 1e-4, "batch_size": 16})
    for step in range(50):
        loss = 2.0 * math.exp(-step / 15) + 0.1
        run.log_metrics({"train.loss": loss}, step=step)
    print("Run:", run.id)
```

```sh
~/.venvs/mmt/bin/python train_sdk.py
```

`Run: <RunのID>`と表示されれば記録できています。`with`を抜けるとRunは完了になり、例外で抜けた場合は失敗になります。

SDKの詳しい使い方（system metrics、途中からの再開、オフラインで記録してあとから送る方法）は[Python SDK](/tracking/sdk)を参照してください。

## 5. MLflow 3 SDKで記録する

既存の学習コードがMLflowで記録している場合は、接続先を変えるだけで同じProjectへ記録できます。［プロジェクト設定］の「MLflow 3から接続」に、このProjectの`MLFLOW_TRACKING_URI`と設定例が表示されます。

![MLFLOW_TRACKING_URIと環境変数の設定例を表示した「MLflow 3から接続」](/images/guide-mlflow-connection.png)

```sh
~/.venvs/mmt/bin/pip install 'mlflow>=3,<4'
export MLFLOW_TRACKING_URI=https://tracking.example.com/api/mlflow/projects/<ProjectのID>
export MLFLOW_REGISTRY_URI="$MLFLOW_TRACKING_URI"
read -r -s -p 'API token: ' MLFLOW_TRACKING_TOKEN
export MLFLOW_TRACKING_TOKEN
```

tokenは手順3で発行したものを使えます。次の内容を`train_mlflow.py`として保存して実行します。

```python
import math

import mlflow

mlflow.set_experiment("whisper-small-finetune")
with mlflow.start_run(run_name="lr-5e-5"):
    mlflow.log_params({"learning_rate": 5e-5, "batch_size": 16})
    for step in range(50):
        mlflow.log_metric("train.loss", 1.8 * math.exp(-step / 20) + 0.15, step=step)
```

```sh
~/.venvs/mmt/bin/python train_mlflow.py
```

`set_experiment`は同じ名前の実験があればそれを使うので、手順4と同じ実験に記録されます。SDKが最後に表示する`View run ...`のリンクはMLflow標準の画面の形式で、このアプリでは開けません。結果はこのアプリの画面で確認します。

対応しているMLflowの機能は[MLflow 3 SDKから記録](/tracking/mlflow)を参照してください。

## 6. 画面で確かめる

［Experiments］で実験を選ぶと、記録したRunが一覧に並びます。`train.loss`の最新値、params、作成者を確認できます。

![2つのRunが並んだwhisper-small-finetuneの一覧](/images/guide-quickstart-runs.png)

［図を表示］を押すと、一覧のRunのメトリクスが図になります。2つのRunの`train.loss`を重ねて比べられ、図の横（画面の幅が足りないときは下）の平行座標でparamsと結果の関係を確認できます。

![2つのRunのtrain.lossを重ねた図と平行座標](/images/guide-quickstart-chart.png)

Run名を押すとRunの詳細が開き、メトリクス、Artifact、ログ、system metricsをタブで切り替えて確認できます。図の操作は[メトリクスの図](/tracking/charts)、比較は[Runの比較](/tracking/compare)を参照してください。

## 7. モデルの登録から自動評価までを試す

モデル版を登録すると、そのモデル系列に合う自動実行ルールが推論と評価のJobを登録し、workerが実行します。最短で試す流れは次のとおりです。

### 準備: workerと実行するコード

1. GPUのあるホスト（CPUだけでもかまいません）へworkerを導入し、Compute targetとして登録します。手順は[workerの導入](/compute/worker)と[Compute target](/compute/targets)にあります。
2. 推論と評価のコードを、［Code］でコード版として登録します。実行種別（推論、評価）と、対応するモデル系列（例: `whisper`）を指定します。手順は[Taskとコード版](/models/tasks)にあります。CPUだけで動く推論と評価の例（`inference.py`、`evaluation.py`）が、SDKを入れた仮想環境の`share/mado-tracking/examples/`（手順4の例では`~/.venvs/mmt/share/mado-tracking/examples/`）にあります。
3. 評価に使う正解データを、データセット版として登録します（[データセット](/data/datasets)）。

### 自動実行ルールを作る

［Models］の「自動実行ルール」で［自動実行ルールを作成］を押し、推論と評価の2つのルールを作ります。

| 項目 | 推論のルール | 評価のルール |
| --- | --- | --- |
| 名前 | `登録時に推論` | `推論のあとに評価` |
| トリガー | モデル登録 | 上流ruleの成功（上流rule: `登録時に推論`） |
| 対象モデル系列 | `whisper` | `whisper` |
| 実行種別 | 推論 | 評価 |
| Experiments | `whisper-small-finetune` | `whisper-small-finetune` |
| コード版 | 推論のコード版 | 評価のコード版 |
| Compute target | 準備の1で登録したもの | 同じもの |
| 入力データセット版 | なし | 準備の3の正解データ |

評価のルールは、推論Runの出力を上流の出力として受け取ります。ルールは作成後に有効・無効だけを変えられます。設定を変えるときは新しいルールを作ります。

### モデル版を登録する

MLflow 3 SDKで登録する場合は、登録モデルの`mmt.model_family` tagでモデル系列を指定します。

```python
import mlflow
import mlflow.pyfunc


class EchoModel(mlflow.pyfunc.PythonModel):
    def predict(self, context, model_input):
        return model_input


client = mlflow.MlflowClient()
client.create_registered_model("whisper-small-ja", tags={"mmt.model_family": "whisper"})
mlflow.set_experiment("whisper-small-finetune")
with mlflow.start_run(run_name="lr-5e-5 (model)"):
    recorded = mlflow.pyfunc.log_model(name="model", python_model=EchoModel())
version = mlflow.register_model(recorded.model_uri, "whisper-small-ja")
print("version", version.version)
```

`version 1`と表示されれば登録できています。版の番号は1から順に自動で採番されます。［Models］の一覧にも`whisper-small-ja`がモデル系列`whisper`で表示されます。

### 結果を確かめる

［Models］で版を選び、［版の詳細画面を開く］を押します。「自動実行」に、1段目の推論と2段目の評価が並びます。Jobが終わると、「評価結果」に評価Runの指標が表示されます。

![学習Run、モデル版、推論Run、評価Runのつながりと自動実行の一覧](/images/guide-model-version-automation.png)

起動に失敗した場合は、「起動結果」と「ジョブエラー」に理由が表示されます。評価の結果で`production`などのaliasを移す設定は[評価と昇格](/models/promotion)、自動実行の詳しい設定は[推論・評価の自動実行](/models/automation)を参照してください。
