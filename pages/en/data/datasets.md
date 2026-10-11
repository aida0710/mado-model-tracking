---
title: Datasets
description: Create dataset versions and link them to Run inputs and outputs. Build versions from folders or Run outputs, and let the worker prepare the contents on compute machines.
---

# Datasets

![Dataset versions and file list](/images/data-datasets.png)

A dataset is a collection of data used for training or evaluation. Each time the contents change you create a new version, and each Run records which version it used. Versions cannot be changed after they are created, so you can repeat training or evaluation with exactly the same version later.

The contents of a version are either files saved in mado ML Tracking as Artifacts, or a URI that points to an external location. When a version is a Run input, the worker prepares its contents on the GPU machine before the code starts.

The web UI is in Japanese. This page shows UI labels in Japanese followed by an English translation.

## When to use it

- You want to register a local audio corpus folder as a version as is.
- You want to keep inference outputs as a version that the next evaluation can use as input.
- You want to trace in Lineage which data a model version was trained on.
- You want to send training data to a GPU machine that cannot reach the API directly.
- You want to use dataset versions managed in Mado as experiment inputs.

## Kinds of versions

| Kind | Contents | Created by |
| --- | --- | --- |
| Artifact-backed version | A list of saved Artifacts. The version list shows Artifact N件 · size | Folder upload, Python SDK, Run outputs |
| Reference version | A URI (`s3://`, `https://`, `file://`, and so on) and a digest. The version list shows 参照 (reference) | **バージョンを作成** (Create version), MLflow `log_input`, import from Mado |

An Artifact-backed version has a digest (`sha256:<hex>`) computed from the path, SHA-256, and size of each file. Uploading the same contents again gives the same digest. Its URI is `mmt-dataset://<version ID>`.

One version can contain up to 100,000 files.

## Register a dataset

1. Open **Datasets** in the sidebar.
2. Click **データセットを登録** (Register dataset).
3. Enter **名前** (Name, required), **Namespace**, and **説明** (Description), and save.

A namespace groups datasets, for example `voice`. **データセットを登録** is shown to editors and above.

## Create a version from a folder

The browser uploads the contents of a folder as Artifacts and creates the version once every file is saved.

1. Select a dataset and click **フォルダから作る** (Create from folder).
2. Click **フォルダを選択** (Choose folder) or drop a folder.
3. Optionally fill in:
   - **バージョン（空なら自動採番）** (Version; numbered automatically when empty): integers such as `1` and `2` are used when empty
   - **親のバージョン** (Parent version): the version this one was derived from
   - **Metadata（JSON）**: for example `{"language": "ja", "sampleRate": 16000}`
4. Click **uploadしてバージョンを作成** (Upload and create version).

Files are sent the same way as in [Large file uploads](/en/data/uploads). If some files fail, the version is not created. Click **残りのファイルを再送** (Resend remaining files) or **残りのファイルを除いてバージョンを作成** (Create version without the remaining files). If only creating the version fails, click **バージョンの作成を再試行** (Retry creating the version); files are not uploaded again.

Selecting a version shows ファイル数 (file count), 合計サイズ (total size), and the file list. Select a file to preview it, just like an Artifact.

## Create a version with the Python SDK

Pass a folder to `files` of `register_dataset` to upload its contents and create a version. Without `dataset_id`, a new dataset is created with `name`.

```python
from mado_tracking import Client

with Client() as client:
    version = client.register_dataset(
        "<Project ID>",
        name="speech-corpus",
        namespace="voice",
        files="data/speech",
        metadata={"language": "ja"},
    )
```

To add a version to an existing dataset, use `upload_dataset_directory`.

```python
from mado_tracking import Client
from mado_tracking.dataset_upload import upload_dataset_directory

with Client() as client:
    version = upload_dataset_directory(
        client, "<Project ID>", "<Dataset ID>", "corpus/",
        version=None,                 # None numbers the version automatically
        metadata={"language": "ja"},
        schema={"sampleRate": 16000},
    )
```

For each file, the SDK looks for a saved Artifact with the same SHA-256 and size and reuses it instead of uploading. If most files match the previous version, only the changed files are sent. After an interruption, running it again sends only the files not yet saved.

When you use `files`, do not pass `uri`, `digest`, `source_run_id`, `parent_dataset_version_ids`, or `external_ref`.

## Create a version that references a URI

To create a version that points to an external location without saving files, select the dataset, click **バージョンを作成** (Create version), and fill in:

| Field | Value | Example |
| --- | --- | --- |
| バージョン (Version) | Version name (required) | `2026-10` |
| URI | Location of the data (required) | `s3://corpus/speech/2026-10/` |
| Digest | Hash of the contents (required) | `sha256:<64 hex digits>` |
| 親のバージョン (Parent version) | The version this one was derived from | |
| 生成元Run (Source Run) | The Run that produced this version | |
| Schema（JSON）, Metadata（JSON） | Any JSON | `{"columns": ["audio", "text"]}` |

## Create a version from Run outputs

Files written by an inference or preprocessing Run can become a version that the next Run uses as input. A version created from Run outputs records its source Run and is connected in Lineage by a データ出力 (data output) edge.

- In code run by a Task, declare outputs in `datasets` of `/mmt/outputs/result.json` (version 2). After saving the output files, the worker registers a version with an integer number. A Run can declare up to 64 datasets.
- In the Python SDK, `run.register_output_dataset(version=, uri=, digest=)` registers a reference version. The Run's input versions become its parents.
- Through the API, `POST /api/projects/<Project ID>/datasets/<Dataset ID>/versions` with `content` set to `{"kind": "artifacts", "fromRunArtifacts": {"runId": "<Run ID>", "prefix": "outputs/audio"}}` creates a version from the Run's Artifacts under `prefix`.

See [Tasks and code versions](/en/models/tasks) for `result.json`. To pass inference outputs to an evaluation Run automatically, see [Automation](/en/models/automation).

## Use a version as a Run input

Choose input dataset versions when running a Task or in an automation rule. Before starting the code, the worker prepares the contents in the work directory of the GPU machine and verifies them.

| Version | What the worker does |
| --- | --- |
| Artifact-backed | Fetches the files and checks the digest and the SHA-256 and size of each file |
| `file://` reference | Uses the path on the machine as is, without copying |
| `https://` reference | Downloads one file without authentication. Checks SHA-256 when the digest is one |
| `s3://` reference | Downloads using the machine's `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, and related variables |
| `urn:` or `mmt-artifact:` reference | Does not download anything |

If the contents cannot be prepared (download failure, verification mismatch, unsupported URI), the Job fails without starting the code. The reason appears in the Run **Logs**.

The code finds the contents through the `MMT_INPUT_DATASET_DIRS` environment variable (JSON mapping version IDs to directories). The directories are read-only.

```python
import json, os, pathlib

for version_id, directory in json.loads(os.environ.get("MMT_INPUT_DATASET_DIRS", "{}")).items():
    for wav in sorted(pathlib.Path(directory).rglob("*.wav")):
        ...
```

In Docker, Singularity, and Apptainer, the contents are at `/mmt/datasets/<version ID>`.

### Transfer and cache

Set **データセットの転送** (Dataset transfer) and **データセットのcache上限（GiB）** (Dataset cache limit, GiB) when editing a Compute target.

| Dataset transfer | What it does |
| --- | --- |
| workerが中継する (Relay through the worker, default) | The worker fetches from the API and sends everything to the GPU machine. Works even when the GPU machine cannot reach the API. The worker needs free space for one version temporarily |
| targetがAPIから直接取得する (Target fetches from the API) | The GPU machine fetches from the API with a Job-scoped token. The GPU machine must be able to reach the API |

Fetched contents are cached in `<work directory>/.mmt-cache/datasets/` on the machine. The next Job that uses the same version reuses the cache. When the cache exceeds its limit (100 GiB by default), the least recently used entries are removed. Versions used by running Jobs are never removed. A version larger than the limit makes the Job fail.

See [Compute targets](/en/compute/targets).

## Use datasets from Mado

With the Mado plugin registered, you can import dataset versions managed in Mado.

1. Click **Madoからインポート** (Import from Mado) on the **Datasets** page. The **Plugins** page opens.
2. Find the dataset with **データセットを検索** (Search datasets).
3. Choose a version and click **インポート** (Import).

An imported version is a reference version that keeps its name, namespace, and version from Mado. Importing the same version again does not add a new version. **Madoからインポート** is shown to Project admins.

When a Run starts and finishes, its input and output versions are sent to Mado, so Mado's dataset lineage shows which experiments used them. See [Plugins and Mado integration](/en/admin/plugins) to register the plugin.

## Datasets you no longer use

Datasets and versions cannot be deleted. To retire a dataset, send `{"archived": true}` to `PATCH /api/projects/<Project ID>/datasets/<Dataset ID>`. New Runs can no longer use versions of an archived dataset as input; existing Runs keep their records. The UI has no archive action.

Artifacts referenced by a version cannot be deleted while the version exists.

## Related pages

- [Large file uploads](/en/data/uploads)
- [Artifacts](/en/data/artifacts)
- [Automation](/en/models/automation)
- [Compute targets](/en/compute/targets)
