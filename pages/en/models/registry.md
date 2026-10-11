---
title: Models and versions
description: Models, versions, model families and aliases, how to register versions, automatic version numbering, and lineage from training Runs to inference and evaluation.
---

# Models and versions

![The model and version list](/images/models-registry.png)

The **モデルとバージョン** (Models and versions) tab of Models registers trained weights as model versions and uses aliases to point at the version currently in use. A version cannot be changed after registration, so you can always tell which weights a Run used for inference or evaluation.

The web UI is in Japanese. This page shows each label as it appears on screen, followed by an English translation.

## When to use it

- Keep the weights a training Run produced together with the Run that produced them
- Refer to a model by an alias such as `production` instead of a version number in inference and evaluation code
- Run inference and evaluation automatically whenever a new version is registered ([Automation after registration](/en/models/automation))
- Switch the production version only after checking evaluation results ([Evaluation and promotion](/en/models/promotion))

## Models, versions, families, and aliases

| Term | Meaning |
| --- | --- |
| Model | A name that groups versions. It has a name, a model family, and a description. The name and family cannot be changed after creation |
| Version | The result of one training. It holds the weights (an Artifact or a URI), the source Run, parent versions, a default code version, and metadata. It cannot be changed after registration |
| Model family | A string for the kind of model architecture, such as `qwen3` or `linear`. It is matched against a code version's supported model families and an automation rule's target families, so code never runs a model it was not written for |
| Alias | A name that points at a version, such as `production` or `candidate`. Every change records when, who, and from which version to which version |

Version fields:

- Source Run: the training Run that produced the weights. The version page links to it.
- Parent versions: the versions a fine-tuning started from. Only versions of the same family can be selected.
- Weights Artifact or weights URI: where the weights are. The worker downloads them before inference or evaluation.
- Default code version: the code version used by default to run this version. Only code versions that support the version's family can be selected.

## Create a model

You need the editor role in the Project. An API token also needs the `registry:write` scope.

1. Open Models and press **モデルを登録** (Register model).
2. Enter the model name in **名前** (Name) and the family in **モデル系列** (Model family), for example `voice-tts` and `linear`. Use the same string as the code version's supported model families.
3. Press **保存** (Save) and check that the model appears in the list on the left.

## Register a version

There are five ways to register a version. To go from training to registration without manual steps, use the Task output setting or register from the training code.

| Method | Version name | Suitable for |
| --- | --- | --- |
| **バージョンを作成** (Create version) in the web UI | Required | Registering weights created elsewhere |
| [Task output model setting](/en/models/tasks#register-a-model-when-training-succeeds) | Numbered automatically (a version name template is also available) | Registering the weights of successful training without changing the training code |
| Python SDK `register_output_model()` | Numbered automatically when omitted | Registering from inside the training code |
| MLflow `register_model()` or `log_model(registered_model_name=…)` | Numbered automatically | Training already logged with the MLflow 3 SDK |
| `models` in a container's `result.json` (version 2) | Numbered automatically | Training in a container without the SDK |

### Register from the web UI

1. Select the model in the list and press **バージョンを作成** (Create version).
2. Enter a name in **バージョン** (Version), for example `3`. The web UI does not number versions for you.
3. Select the training Run in **生成元Run** (Source Run), then enter the weights' Artifact ID in **Artifact ID** or a URI in **重みのURI** (Weights URI). The Artifact ID is shown when you open the weights file in the Artifacts tab of the training Run.
4. Optionally select **親のバージョン** (Parent versions) and **既定のコードバージョン** (Default code version), then press **保存** (Save).
5. Check that a new row appears in the version list and that **最新のバージョン** (Latest version) has changed.

### Register from training code

With the Python SDK, save the weights inside the training Run and register them. If the model named by `model_name` does not exist, it is created with the given `family`.

```python
from mado_tracking import Client

with Client() as client:
    with client.start_run(
        project_id="<project-uuid>",
        experiment_id="<experiment-uuid>",
        name="train-v3",
        kind="training",
    ) as run:
        ...  # train and save weights.bin
        artifact = run.log_artifact("weights.bin", path="model/weights.bin")
        version = run.register_output_model(
            model_name="voice-tts", family="linear", artifact_id=artifact["id"],
        )
        print(version["version"])  # the assigned version name, for example 3
```

With the MLflow 3 SDK, set the family in the registered model's `mmt.model_family` tag. See [Log with the MLflow 3 SDK](/en/tracking/mlflow) for the connection settings.

```python
version = mlflow.register_model(recorded.model_uri, "voice-tts")
loaded = mlflow.pyfunc.load_model("models:/voice-tts@production")
```

## Automatic version numbering

When the version name is omitted, versions are numbered `1`, `2`, `3`, and so on for each model, following the same rule as MLflow.

- The web UI, the Python SDK, MLflow, Tasks, and `result.json` all share one sequence per model. Registrations from different paths never collide.
- Numbers of deleted versions are not reused.
- Registering an explicit integer such as `10` moves the next number to `11`.
- Non-integer names such as `v1` and numbers with 19 or more digits are ignored when numbering. Existing versions with such names are kept.
- Registering a name that already exists is rejected (409).

## Set an alias

![The alias (promotion) dialog](/images/models-promotion-dialog.png)

1. Select the model and press **Aliasを設定** (Set alias).
2. Enter the alias in **Alias** and choose the version in **バージョン** (Version), for example `production` and `3`.
3. Enter the reason in **理由** (Reason) and press **保存** (Save). The reason is optional, but a protected alias may require it.
4. Check that the alias points at the version in the alias list.

To remove an alias, press **Aliasを解除** (Remove alias) in the alias list. Removals are recorded too.

When you start an inference or evaluation Run with an alias, the Run stores the version the alias pointed at at that moment. Moving the alias later does not change past Runs.

**Aliasの履歴** (Alias history) lists the time, the old and new version, the actor, and the path of each change (Web, API, MLflow, promotion policy, version deletion, model deletion), newest first. The history is append-only.

You can restrict who may change important aliases such as `production`. See [Protected aliases](/en/models/promotion#protect-an-alias).

## Open a version

![The version page](/images/models-version.png)

Select a version and press **バージョンの詳細画面を開く** (Open version page).

- **学習Run → バージョン → 推論・評価Run** (Training Run → version → inference and evaluation Runs): the training Run that produced the version and up to 20 of the newest Runs that used it.
- **自動実行** (Automation): automation runs triggered by this version.
- **評価結果** (Evaluation results): the latest metrics of successful evaluation Runs and the comparison with the baseline version ([Evaluation and promotion](/en/models/promotion)).
- **昇格の判定** (Promotion check): whether the version passed each promotion policy.

## Follow relationships in Lineage

![The Lineage page](/images/models-lineage.png)

Lineage draws dataset versions, Runs, MLflow logged models, model versions, and code versions of the Project in one graph. Read it from left to right to see which data trained a version and which version produced an inference output.

Edges are data input, data output, model input, model output, model registration, parent model, parent dataset, parent Run, and code. Open **関係** (Relations) below the graph to see the edges as a table.

## Permissions

| Action | Required role |
| --- | --- |
| View the list, version pages, and Lineage | viewer or higher |
| Create models and versions, set and remove aliases | editor or higher (`registry:write` for API tokens) |
| Change a protected alias | Depends on the protection ([Protected aliases](/en/models/promotion#protect-an-alias)) |

## Next steps

- In [Tasks and code versions](/en/models/tasks), register a version when training succeeds.
- In [Automation after registration](/en/models/automation), run inference and evaluation for each new version.
