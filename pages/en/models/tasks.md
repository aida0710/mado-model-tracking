---
title: Tasks and code versions
description: Pin the code to run as a version and launch normal and test runs from a Task. Choosing a repository, standalone code, or a container, and registering the output model when training succeeds.
---

# Tasks and code versions

![A Task and its output model setting](/images/models-tasks.png)

A Task stores what to run: which code, with which model and data, and where. Tasks live under an Experiment, and you launch normal and test runs from them. The code is pinned as a code version, so after you edit the code you can still see exactly what each past Job ran.

## When to use it

- Launch the same training many times with different parameters
- Check that the code works with a short test command before the real training
- Edit a Git repository to try something without pushing to it
- Register the output weights as a model version automatically when training succeeds

## Overview

1. Prepare a computer (Compute target) to run on: add one under コンピュータ (Computers) in the global settings, or pick one you can use. See [Computers and visibility](/en/compute/computers) and [Compute targets](/en/compute/targets).
2. Register code in Code and create a version.
3. Create a Task in Tasks, select the Experiment, code version, and Compute target, and save.
4. Check with **テスト実行** (Test run), then launch with **通常実行** (Run).
5. Check metrics, logs, the exit status, and Artifacts in the Run.

Jobs are executed by a worker. Without a worker for the target, the Job stays queued. See [Install and run the worker](/en/compute/worker).

## Register a code version

![The code version editor](/images/models-code-editor.png)

In Code, press **コードを登録** (Register code) to create the code entry, then **バージョンを作成** (Create version). A version cannot be changed after saving. Saving an edit creates a new version.

| Field | Meaning |
| --- | --- |
| **バージョン** (Version) | The version name, for example `v1` |
| **Runtime** | Python, Docker, Singularity, or Apptainer |
| **ソース形式** (Source format) | Git, Inline (files stored in the app), Artifact (a stored ZIP or TAR), or code inside the container |
| **実行コマンド** (Command, JSON array of arguments) | The command of a normal run, for example `["python", "train.py"]` |
| **テストコマンド** (Test command, optional) | The command of a test run, for example `["python", "train.py", "--steps", "2"]` |
| **依存パッケージ** (Dependencies, one per line) | Packages installed into the per-Job venv for Python, for example `numpy>=1.26` |
| **環境変数** (Environment, JSON) | Environment variables for the code. Do not put credentials here |
| **対応モデル系列** (Supported model families, one per line) | Model families this code can run, for example `linear` |
| **対応する実行種別** (Supported run kinds) | Training, fine-tuning, inference, evaluation, data processing |

Commands do not go through a shell. Each element of the JSON array is passed as one argument, up to 100 arguments of up to 4000 characters each.

### Start from a sample

Select a sample in **サンプル** (Sample) and press **サンプルを追加** (Add sample) to load files and normal and test commands: a standard-library smoke test, Mado SDK metrics, MLflow 3 metrics, CPU inference, and CPU training.

The CPU training sample only saves weights to the Run Artifact `model/weights.json`. Registration is done by the Task output model setting described below.

### Use a repository

Choose Git as the source format and enter **Git URL** and **Commit**. The commit must be a full 40- or 64-character hash; branch and tag names are not accepted. The URL must be HTTPS or SSH without credentials.

Press **Gitのファイルを読み込む** (Load Git files) to load the pinned commit into the editor. Saving creates a version that overlays the changed files and deleted paths on the pinned commit. Nothing is pushed to the original repository. Binary or large files that were not loaded are listed under **編集対象外のパス** (Paths not edited) and are fetched from the original commit at run time.

Training and inference code in the same repository can be registered as separate code versions with different commands. To use another repository for inference only, choose **別のリポジトリ** (Another repository) in **リポジトリの選択** (Repository).

### Store standalone code

Choose **Standalone（ファイルを保存）** (Standalone, store files) in **リポジトリの選択** to store files in the app. Enter a relative path such as `src/main.py`, press **ファイルを追加** (Add file), and write the content in the editor (Monaco Editor). Closing the dialog with unsaved changes asks before discarding them.

### Run in a container

| Runtime | What to specify |
| --- | --- |
| Docker | **Docker image（digest固定）** (Docker image pinned by digest), for example `registry.example.com/team/infer@sha256:<64-digit digest>`. A tag alone such as `image:latest` is rejected |
| Singularity, Apptainer | **SIF Artifact**. Selecting a stored SIF file fills in its SHA256 |

- When the code is inside the image, choose code inside the container as the source format.
- An added Git, Inline, or Artifact source is mounted read-only at `/mmt/source`.
- The working directory inside the container must be an absolute path, for example `/app`.
- Containers do not use the dependency list. Put what you need into the image.

The Compute target must list the runtime ([Compute targets](/en/compute/targets)). Paths and environment variables inside the container are listed in [Install and run the worker](/en/compute/worker#what-the-code-receives).

## Create a Task

1. In Tasks, press **Taskを作成** (Create Task).
2. Fill in the fields and press **保存** (Save).

| Field | Meaning |
| --- | --- |
| Name | For example `voice synthesis training` |
| Experiments | The Experiment that records the Runs |
| Run kind | Training, fine-tuning, inference, evaluation, data processing |
| Model version | The input model version (the base of a fine-tuning, the version to run inference with). Optional |
| Code version | Only code versions that support the run kind and model family can be selected |
| Input dataset versions | Dataset versions the worker fetches before running. Optional |
| Compute target | Only targets you can use and that support the code version's runtime can be selected. A Private target can be used only by its owner and the Service Accounts the owner created |
| GPU ID | GPUs registered on the target. Without a GPU the Job runs on CPU only |
| Parameters, tags | JSON, for example `{"epochs": 8}` |

3. Select the new Task and check that the saved settings are shown on the right.

Each save increments **Taskの改訂番号** (Task revision). If someone else updated the Task in the meantime, saving is rejected; check the latest settings and save again.

## Normal and test runs

Press **通常実行** (Run) or **テスト実行** (Test run) on the Task. To change parameters for this launch, enter only the changed values in **パラメータの上書き（JSON）** (Parameter overrides).

| | Command | Model registration |
| --- | --- | --- |
| Normal run | The code version's command | Registered on success if an output model is set |
| Test run | The code version's test command | Never |

A test run requires a test command in the code version.

The Task revision, code version, source, runtime, command, dependencies, and environment at launch are stored in the Run's **実行snapshot** (Execution snapshot). Editing the Task or code afterwards does not change that Run.

The worker saves the source before execution as a ZIP and a manifest in the Run Artifacts, even for failed test runs. The manifest shows the Git commit and the SHA-256 of each file.

**実行履歴** (Run history) shows the latest 50 runs; **古い実行** (Older runs) and **最新の実行** (Latest runs) page through it.

To run a failed Job again, use **新しいRunで再実行** (Retry in a new Run) in Jobs. It creates a new Run with the previous code version, mode, Task revision, and parameters, and keeps the original Run. To try edited code, change the Task's code version and launch again.

## Register a model when training succeeds

Training and fine-tuning Tasks can register the weights of a successful Run as a model version, without registration code in the training script.

1. Open **Taskを編集** (Edit Task) and check **成功時にモデルバージョンを登録** (Register a model version on success) under **出力モデル** (Output model).
2. In **登録先** (Destination), choose **既存のモデル** (Existing model) or **新しいモデルを作成** (Create a new model).
   - Existing model: select it in **登録先のモデル** (Destination model).
   - New model: enter **モデル名** (Model name) and **モデル系列** (Model family). The family must be one the Task's code version supports. An existing model with the same name is reused.
3. Enter the path of the weights file the training code saved in **Artifactのパス** (Artifact path), for example `model/weights.json`. It must match the file path exactly.
4. Optionally select **登録するバージョンの既定コードバージョン** (Default code version of registered versions) and press **保存** (Save).
5. Press **通常実行** (Run); the confirmation shows the destination model.

If the training code writes files to `MMT_OUTPUTS_DIR` instead of using the SDK, their Artifact paths start with `container/`. For example `MMT_OUTPUTS_DIR/model/weights.bin` becomes `container/model/weights.bin`.

Versions are numbered automatically. Tasks created with the Python SDK or the API can also set a version name template using `{runId}`, `{runName}`, and `{taskRevision}`.

The output model setting is copied to the Run at launch; editing the Task afterwards does not change where that Run registers. The result is shown in **出力モデル** (Output model) on the Run page.

| Run result | Registration |
| --- | --- |
| Finished | Registers a version. Automation rules for the model's family then run inference and evaluation |
| Finished, and the training code already registered to the same model | The Task does not register again. There is one version and one set of downstream runs |
| Finished, but the Artifact is missing or the creator lost access | Registration fails with a reason. The Run stays finished |
| Failed, canceled, or a test run | Not registered |

## Change Compute targets and plugins

Compute targets are added under コンピュータ in the global settings, and their owner and global administrators change their settings. Only global administrators add SSH and Local targets; anyone can add a site ([Computers and visibility](/en/compute/computers)). Only global administrators add plugins, change their settings, and enable or disable them ([Plugins and Mado integration](/en/admin/plugins)).

## Next steps

- [Automation after registration](/en/models/automation) runs inference and evaluation for registered versions.
- [Resume training](/en/models/checkpoints) continues a stopped training from a checkpoint.
