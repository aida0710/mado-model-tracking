---
title: Record from MLflow 3
description: Connect the official MLflow 3 SDK with MLFLOW_TRACKING_URI and an API token. Supported features, Basic authentication, autolog, and model registration.
---

# Record from MLflow 3

![The "Connect from MLflow 3" section of the Settings page](/images/tracking-mlflow-connection.png)

The official `mlflow` Python SDK (MLflow 3) can record into a Mado Model Tracking Project. Set the server and token in environment variables and keep your MLflow code as it is. Runs, metrics, Artifacts, and registered models recorded this way are the same data as those recorded from the Web UI.

This is not a server with every MLflow feature. Check the [supported features](#supported-features) table.

## When it helps

- Sending existing MLflow training code to the in-house server without changes
- Using automatic logging such as `mlflow.sklearn.autolog()`
- Connecting models registered with `mlflow.register_model()` to automatic inference and evaluation

## Connect

1. Open the Project's **Settings** and find MLflow 3から接続 (Connect from MLflow 3). `MLFLOW_TRACKING_URI` and `MLFLOW_REGISTRY_URI` show the same URL, `https://<server>/api/mlflow/projects/<Project ID>`
2. Choose このProject用のAPI tokenを発行 (Issue an API token for this Project). The token form opens with `read`, `runs:write`, `registry:write`, and `artifacts:write` selected; enter a name and expiry and issue it. The token is shown only once, so keep it (the button is shown to editors and above)
3. In a terminal on the training machine, install MLflow and set the environment variables

```bash
python3 -m pip install 'mlflow>=3,<4'
export MLFLOW_TRACKING_URI='https://tracking.example.internal/api/mlflow/projects/PROJECT_ID'
export MLFLOW_REGISTRY_URI="$MLFLOW_TRACKING_URI"
read -r -s -p 'API token: ' MLFLOW_TRACKING_TOKEN
export MLFLOW_TRACKING_TOKEN
```

The コピー (Copy) button next to the environment variable example copies these lines with the Project's URL. Never put the token in source code or Git-tracked files; pass it to containers as an environment variable.

| Purpose | Scope |
| --- | --- |
| Read Experiments, Runs, models, and Artifacts | `read` |
| Record Experiments, Runs, params, metrics, and tags | `runs:write` |
| Register a new input Dataset | `runs:write` and `registry:write` |
| Upload Artifacts | `artifacts:write` |
| Register or change Logged Models, model versions, and aliases | `registry:write` |

The recording user needs the editor role or higher in the Project. For workers and other long-running automation, use a Service Account token rather than a personal one: tokens of SSO users stop working seven days after their groups were last checked ([API tokens](/en/admin/tokens)).

### Check the connection

Run the following; if an Experiment `connection-check` with one Run appears under **Experiments**, the connection works.

```python
import mlflow

mlflow.set_experiment("connection-check")
with mlflow.start_run(run_name="hello"):
    mlflow.log_param("learning_rate", 0.01)
    mlflow.log_metric("loss", 0.5, step=1)
```

A 401 means the token value or expiry is wrong; a 403 means a missing scope or Project role.

## Connect with Basic authentication

Internal tools that only accept a user name and password can use Basic authentication. Put the API token in the password. The user name is not checked, so any value works.

```bash
export MLFLOW_TRACKING_URI='https://tracking.example.internal/api/mlflow/projects/PROJECT_ID'
export MLFLOW_TRACKING_USERNAME=mado
read -r -s -p 'API token: ' MLFLOW_TRACKING_PASSWORD
export MLFLOW_TRACKING_PASSWORD
```

- Basic authentication works only on the MLflow-compatible endpoints (`/api/mlflow/...`)
- A local account password is not accepted
- Revocation, expiry, scopes, and Project roles are checked exactly as with `MLFLOW_TRACKING_TOKEN`

The page shows this example under Pythonの例・Basic認証 (Python example and Basic authentication).

## Record Runs and Artifacts

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

- Logging a different value for an existing param is an error. Use a new Run for new conditions
- The latest metric value is chosen by step and timestamp, not arrival order. NaN is stored as is
- Run links printed by the SDK use the MLflow UI format; open Runs from **Experiments** instead
- Artifacts are stored in the storage the administrator chose (a file system or S3-compatible storage). The SDK needs no storage credentials
- `mlflow.start_run(run_id="RUN_ID")` reopens a finished Run to record more. Runs executed by a worker Job cannot be reopened

Large files can be split with MLflow's multipart upload. SDK 3.17 and later use it automatically; for 3.0 to 3.16, set `MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true`. By default the SDK splits files of 500 MiB or more into 10 MiB parts. Keep the part size (`MLFLOW_MULTIPART_UPLOAD_CHUNK_SIZE`) at 5 MiB or more; a file can have at most 10,000 parts, so a 200 GiB file needs at least 21 MiB. See [Uploading large files](/en/data/uploads).

## Use autolog

With scikit-learn, params, metrics, input Datasets, and the model are recorded automatically:

```python
import mlflow
import mlflow.sklearn

mlflow.set_experiment("automatic-training")
mlflow.sklearn.autolog(log_models=True, log_datasets=True)
model.fit(features, targets)
```

Only scikit-learn autolog has been verified. Other libraries use different APIs and model formats, and have not been checked.

## Register models

```python
import mlflow
import mlflow.sklearn
import numpy as np
from sklearn.linear_model import LinearRegression

features = np.array([[0.0], [1.0], [2.0]])
targets = np.array([1.0, 3.0, 5.0])
with mlflow.start_run():
    mlflow.log_input(mlflow.data.from_numpy(features, targets=targets, name="training-v1"), context="training")
    model = LinearRegression().fit(features, targets)
    recorded = mlflow.sklearn.log_model(model, name="regression")

version = mlflow.register_model(recorded.model_uri, "regression")
mlflow.MlflowClient().set_registered_model_alias("regression", "candidate", version.version)
loaded = mlflow.pyfunc.load_model("models:/regression@candidate")
```

- Versions are numbered 1, 2, 3, ... automatically, in the same sequence as versions registered from the Web UI. Numbers of deleted versions are not reused
- A registered version pins the model files. Overwriting files in the source Run does not change it
- Load with `models:/name/version` or `models:/name@alias`
- **Lineage** shows the input Datasets, the source Run, and the registered version

To run inference and evaluation automatically on registration, set the registered model tag `mmt.model_family` to a model family and create an automation rule for that family in the Project.

```python
mlflow.MlflowClient().create_registered_model("qwen3", tags={"mmt.model_family": "qwen3"})
```

See [Automation](/en/models/automation) for rules.

## Record tables, images, and audio {#media}

- Items logged with `log_table`, `log_image`, `log_dict`, `log_text`, and `log_figure` are listed and downloadable as Artifacts
- Images logged with `log_image(image, key=..., step=...)` and tables logged with `log_table` also appear on the Run's **Media** tab ([Media Logging and Listening](/en/tracking/media)). With MLflow 3.0.0, do not put `/` in the key (the SDK cuts the file name); 3.17.0 and later are fine
- Save audio with `mlflow.log_artifact`; wav and flac play directly in the browser

## Supported features {#supported-features}

Verified with MLflow 3.0.0 (scikit-learn 1.6.1) and 3.17.0 (scikit-learn 1.9.1). Features not in this table have not been checked.

| Feature | Status |
| --- | --- |
| Runs, nested Runs, params, metrics, tags, search, delete and restore | Supported |
| Artifact upload and download, multipart upload | Supported |
| Logged Models, Model Registry, aliases | Supported |
| scikit-learn autolog | Supported |
| `mlflow.models.evaluate` (results go to the Run and the Logged Model) | Supported |
| `log_table`, `log_image`, `log_dict`, `log_text`, `log_figure` | Supported |
| wav and flac audio Artifacts | Supported |
| Custom pyfunc models and multi-file models | Supported |
| pandas output of `mlflow.search_runs` | Supported |
| Webhooks | Not supported (`ENDPOINT_NOT_FOUND` error) |
| Tracing (`search_traces`, `@mlflow.trace`) | Not supported. Functions decorated with `@mlflow.trace` still run, and the Run finishes normally |
| GenAI evaluation, AI Gateway, Prompt Registry | Not supported |

Search filters are joined with `AND`; `OR` and parentheses are not supported. `IN` and `NOT IN` work for some attributes such as `run_id`.

## Use it inside a worker

A worker passes the MLflow server, token, Experiment, and Run to each Job in environment variables. `mlflow.start_run()` in the code records into the Run assigned to the Job instead of creating one. The token is limited to that Run. Include MLflow 3 in the Job's environment ([Worker](/en/compute/worker)).
