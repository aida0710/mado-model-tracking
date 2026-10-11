---
title: Automation after registration
description: Start inference and evaluation automatically when a model version is registered. Chained rules, passing upstream outputs, applying rules to existing versions, retries, and moving rule ownership to a Service Account.
---

# Automation after registration

![Automation rules and rule details](/images/models-automation-rules.png)

An automation rule starts inference and evaluation Jobs whenever a model version is registered. A rule pins the code version, dataset versions, Compute target, and parameters, so every version is evaluated under the same conditions.

## When to use it

- Go from a finished training straight to inference and evaluation
- Pass the inference output to evaluation automatically
- Fix how evaluation is done so that versions are compared under the same conditions
- Run the same evaluation later for versions registered before the rule existed or during training

## How it works

```text
Training Run → register a version → rule A: inference Run → rule B: evaluation Run → promotion policy decision
```

- The trigger is the registration of a model version. Uploading an Artifact alone does not start anything.
- The same rules run however the version was registered (web UI, Python SDK, MLflow, Task output setting, `result.json`).
- A rule runs once per version. Versions registered before the rule was created are not processed automatically ([Apply a rule to existing versions](#apply-a-rule-to-existing-versions)).
- Inference and evaluation are separate Jobs.

Two chained rules connect registration, inference, and evaluation as above. To decide promotion from the evaluation, see [Evaluation and promotion](/en/models/promotion).

## Create a rule

Only Project admins create rules. API tokens also need the `admin` scope.

1. Open **自動実行ルール** (Automation rules) in Models and press **自動実行ルールを作成** (Create automation rule).
2. Fill in the fields and save.

| Field | Meaning |
| --- | --- |
| Name | For example `inference on registration` |
| **トリガー** (Trigger) | **モデル登録** (Model registration) or **上流ruleの成功** (Upstream rule succeeded) |
| **上流rule** (Upstream rule) | The previous rule, when the trigger is upstream success |
| **対象モデル系列** (Target model families) | Families this rule runs for, chosen from those the code version supports |
| Run kind | Inference, evaluation, or data processing |
| Experiments | The Experiment that records the Runs |
| Code version | A code version that supports the families and the run kind |
| Compute target, GPU ID | Where to run. Without a GPU the Job runs on CPU only |
| Input dataset versions | Data given to every version, such as the evaluation references |
| Parameters, tags | JSON. Tags starting with `automation.` or `mmt.` are reserved for the server |
| **最大試行回数** (Maximum attempts) | 1 to 100. Two or more retries failed Runs automatically. Default 1 |

3. Check that **状態** (Status) of the new rule is **有効** (Enabled).

Rule settings cannot be changed after creation; only enabling and disabling is possible. To change settings, create a new rule and disable the old one with **無効にする** (Disable). This keeps the settings each past run used.

With the Python SDK:

```python
rule = client.create_automation_rule(
    project_id, name="inference on registration", model_families=["linear"], kind="inference",
    experiment_id=experiment_id, code_version_id=code_version_id, target_id=target_id,
    input_dataset_version_ids=[], parameters={"batch_size": 8},
)
```

## Chain evaluation after inference

Create inference rule A with the model registration trigger, and evaluation rule B with the upstream trigger and A as its upstream. Registering a version runs A's inference Run, and B's evaluation Run starts when that Run succeeds.

- The evaluation Run uses the same version as the inference.
- Its input dataset versions are those pinned in B (the reference set) plus the dataset versions the inference Run produced.
- If the inference Run succeeds without producing any dataset version, evaluation is skipped and the history shows that the upstream Run had no output dataset.
- If the inference Run fails or is canceled, evaluation is skipped.
- If a failed inference Run is retried from Jobs and the retry succeeds, evaluation starts with the retry as its upstream.
- Disabling either the upstream or the downstream rule stops the downstream run.
- Chains are limited to five stages including the first.

Runs created by people do not chain, even with the same tags as a rule.

### Receive the upstream Run's outputs

Inference code registers its outputs as dataset versions. Containers without the SDK can declare them in `datasets` of `result.json` (version 2) ([Install and run the worker](/en/compute/worker#what-the-code-receives)).

The evaluation code receives the upstream inference Run as follows.

| Variable | Contents |
| --- | --- |
| `MMT_UPSTREAM_RUN_ID` | ID of the upstream Run |
| `MMT_UPSTREAM_RUN_FILE` | Path of `upstream-run.json` with `{runId, outputDatasetVersionIds, outputModelVersionIds}` |
| `MMT_INPUT_DATASET_DIRS` | JSON mapping each input dataset version to its downloaded directory |

The Python SDK can download the upstream Run's Artifacts from the evaluation code.

```python
from mado_tracking import download_upstream_artifacts, upstream_run_id

print(upstream_run_id())  # None for a Job without an upstream
files = download_upstream_artifacts("upstream", prefix="container/")
```

Files keep their stored paths under `upstream/`.

To refer to inference audio from an evaluation results table, write `mmt-artifact://runs/<inference Run ID>/<stored path>` instead of copying the file. See [Write an evaluation results file](/en/models/promotion#write-an-evaluation-results-file).

## Versions registered during training wait for success

The SDK's `register_output_model()` and MLflow's `log_model(registered_model_name=…)` register a version while the training Run is still running. So that a later training failure does not trigger inference and evaluation, automation for a version whose source Run has not ended waits until it succeeds.

| Source Run | Automation |
| --- | --- |
| None, or already ended at registration | Starts with the registration |
| Running | Waits; the history shows **学習完了待ち** (Waiting for training) |
| Finished while waiting | Starts with the rules enabled at that time |
| Failed or canceled while waiting | Skipped |
| Waiting for more than 7 days, or the training Run was deleted | Skipped as expired |

A wait closed by failure or expiry does not start later even if the training Run succeeds. To run it, [apply the rule to the version](#apply-a-rule-to-existing-versions).

## Check the results

![Automation history](/images/models-automation-history.png)

**自動実行履歴** (Automation history) in Models shows each rule's outcome and the state of the created Runs and Jobs.

| Outcome | Meaning |
| --- | --- |
| **Jobを登録** (Job queued) | A Run and a Job were created. Follow them in the Run and Job status columns |
| **学習完了待ち** (Waiting for training) | Waiting for the training Run to succeed |
| **起動せず** (Skipped) | Conditions were not met. The reason is shown |
| **起動に失敗** (Failed to start) | The Run could not be created, for example because the rule owner lost access or the target is disabled. The registered version is kept |

Chained runs are shown as stage 1, stage 2, and so on. **学習Runを開く** (Open training Run) and **上流のRunを開く** (Open upstream Run) lead to the Run that triggered them. The **自動実行** section of a version page shows the same history for that version.

To be notified of start failures, select `automation.failed` in a Project notification rule ([Notifications](/en/admin/notifications)).

## Apply a rule to existing versions

Project admins can apply an enabled rule to an existing version, for example to:

- Evaluate versions registered before the rule existed
- Run versions that were skipped because training failed or the wait expired
- Re-evaluate the baseline version after changing the evaluation code

1. Select the rule in **自動実行ルール** to open its details.
2. In **既存のバージョンに適用** (Apply to existing version), choose **適用するバージョン** (Version). For a rule with an upstream, choose **上流のRun** (Upstream Run) instead: a successful Run created by the upstream rule that has output dataset versions.
3. Press **適用する** (Apply) and confirm.
4. When **Jobを登録しました** (Job queued) appears, check the state in the automation history.

While a run of the same rule and version is queued or running, applying is rejected. Otherwise a new Run is created with the attempt number increased by one. A manually applied inference that succeeds chains to evaluation as usual.

**再実行** (Rerun) in the automation history and on the version page applies the same rule to the same version (or the same upstream Run) again. Both are shown only to Project admins, and the person who applied it is recorded in the history and the audit log.

## Retry failures automatically

Setting **最大試行回数** (Maximum attempts) to two or more queues the next attempt when an automation Run fails. The default is 1 (no retry) so GPUs are not spent on retries you did not ask for.

| How the automation Run ended | Retried |
| --- | --- |
| Run and Job failed, attempts below the limit | Yes |
| Attempt limit reached | No |
| Canceled by a person | No |
| Rule disabled | No |
| Run created or retried by a person | No |

- Retries start from the beginning, not from a checkpoint. To continue from a checkpoint, resume manually in Jobs ([Resume training](/en/models/checkpoints)).
- A successful retry chains to later rules as usual.
- People can always retry with **新しいRunで再実行** (Retry in a new Run) in Jobs.

## Move rule ownership to a Service Account {#move-rule-ownership}

Automation runs with the permissions of the rule owner, who becomes the creator of the Runs. The owner is initially the person who created the rule. If that person stops being a Project admin, the rule fails to start. For long-lived rules, move ownership to a Service Account that is not tied to a person.

1. In the Project settings, create a Service Account with the admin role. No token is needed ([API tokens and Service Accounts](/en/admin/tokens)).
2. Select the rule in **自動実行ルール** and press **Service Accountへ移す** (Move to Service Account).
3. Choose **移管先のService Account** (Service Account) and confirm.
4. Check that **所有者** (Owner) in the rule details shows `<name>（Service Account）`.

Only Project admins can move ownership, and only to an enabled admin Service Account of the same Project. The rule's creator is still recorded, and the change is in the audit log.

If the rule runs on a Private computer, move ownership to a Service Account created by that computer's owner. A Service Account created by someone else cannot use the computer, so the rule fails to start ([Computers and visibility](/en/compute/computers#visibility)).

## When the evaluation code changes

Rules cannot be edited, so switch evaluation code in this order:

1. Create an evaluation rule with the new code version and the same inference rule as upstream.
2. Disable the old evaluation rule.
3. Apply the new rule with the baseline version's inference Run (for example the version `production` points at) as the upstream Run. Only evaluation runs again with the new code.

Comparisons use evaluation Runs with the same evaluation code version. Without evaluating the baseline with the new code, a new version has nothing to compare with.

## Permissions

| Action | Required role |
| --- | --- |
| View rules and history | viewer or higher |
| Create rules, enable and disable them, apply to existing versions, rerun, move ownership | Project admin (`admin` scope for API tokens) |
