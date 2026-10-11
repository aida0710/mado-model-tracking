---
title: Install and run the worker
description: Install the worker on a worker machine and keep it running with systemd. Preparing the token, the install, status, doctor, and upgrade commands, and the Job-scoped token given to the code.
---

# Install and run the worker

The worker receives Jobs from the API server, connects to Compute targets over SSH, and runs the code. It sends logs, metrics, and output files to the API server during the run and reports the result at the end.

The worker can run on a different machine from the API server. SSH private keys stay on the worker machine; the API server never holds them. Installation, upgrades, and status checks are done on the worker machine with the `mado-tracking-worker` command.

```text
API server ← worker (SSH key, known_hosts, worker token) → Compute target (GPU machine)
```

## When to use it

- Keep the worker running after logout and reboot
- Upgrade the worker without stopping running trainings
- Catch token and key permission mistakes before the first Job

## Requirements

- Linux (tested on Ubuntu)
- Python 3.11 or later, `venv`, `pip`, OpenSSH client, Git
- The worker machine can reach the API server
- Compute targets can also reach the API server, because running code logs metrics. Pointing a target at the worker machine's `127.0.0.1` does not reach that API

On Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip openssh-client git
python3 --version
```

## 1. Prepare a worker token

Issue the worker token to a Service Account, which is not tied to a person and keeps working when the issuer leaves the Project. A Project admin does this in the web UI.

1. Open **プロジェクト設定** (Project settings) and press **Service Accountを作成** (Create Service Account) under **Service Accounts**.
2. Enter a name such as `gpu-host-1-worker`, choose Role `Admin`, and save. The `worker:execute` scope can only be issued to Service Accounts with the Admin role.
3. Press **API tokenを発行** (Issue API token) on the new row and choose scopes and an expiry.

| Scope | When it is needed |
| --- | --- |
| `read` | Always. Used to list input datasets and similar |
| `worker:execute` | Always. Used to claim Jobs and report results |
| `artifacts:write` | Always. Used to save the source before execution and output files |
| `registry:write` | When Jobs declare output models or datasets in `result.json` (version 2) |

The expiry is at most 365 days.

4. Use the displayed token in the next step. It is shown only once.

See [API tokens and Service Accounts](/en/admin/tokens) for details.

## Install the worker

Open a terminal on the worker machine and install the Python package `mado-tracking` into a dedicated venv. The example installs from the GitHub repository; replace the `pip install` argument if you have an internal package index or a wheel.

```bash
git clone https://github.com/aida0710/mado-ml-tracking.git ~/mado-ml-tracking
python3 -m venv ~/.local/share/mado-tracking-worker/venv
~/.local/share/mado-tracking-worker/venv/bin/pip install "$HOME/mado-ml-tracking/python[telemetry]"
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker --help
```

The `telemetry` extra also collects system metrics such as GPU utilization.

## 2. Keep it running with systemd

`install` writes the configuration file and a systemd unit, then starts the worker.

```bash
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker install \
  --api-url https://tracking.example.internal \
  --worker-id gpu-host-1 \
  --target-ids "<target ID>"
loginctl enable-linger "$USER"
```

| Option | Example | Meaning |
| --- | --- | --- |
| `--api-url` | `https://tracking.example.internal` | URL of the API server |
| `--worker-id` | `gpu-host-1` | Worker name. Keep it the same across restarts and upgrades. Letters, digits, `.`, `_`, `-`, up to 64 characters |
| `--target-ids` | target ID | IDs of the Compute targets this worker handles, separated by commas |
| `--token-file` | `/path/to/token` | Read the token from a file. Without it, the terminal asks for it |
| `--state-dir` | | Directory for the records of running Jobs. Usually omitted |

The command asks for the token without echoing it. Never put the token on the command line.

`--target-ids` is optional, but a worker without it never picks up connection checks ([Compute targets](/en/compute/targets#check-the-connection)). To find a target's ID, open `https://tracking.example.internal/api/targets` (the web URL followed by `/api/targets`) in a browser where you are logged in; each target's `id` is listed.

`loginctl enable-linger` keeps user units running after logout.

`install` does the following:

- Writes `~/.config/mado-tracking-worker/<worker-id>.env` with mode 600, containing the API URL, worker ID, targets, state directory, and token.
- Writes `~/.config/systemd/user/mado-tracking-worker@.service`, then enables and starts `mado-tracking-worker@<worker-id>.service`.
- Creates the state directory under `~/.local/state/mado-tracking-worker/`. A worker you previously started by hand used the same location, so running Jobs are taken over.

### System unit

To run as a dedicated user, run as root with `--systemd-system --service-user <user>`. The configuration file is `/etc/mado-tracking-worker/<worker-id>.env` (root, mode 600) and the state directory is `/var/lib/mado-tracking-worker/<worker-id>` (owned by that user, mode 700). Templates for manual setup are `deploy/worker/mado-tracking-worker@.service` and `deploy/worker/worker.env.example` in the repository.

## 3. Check that it runs

```bash
WORKER=~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker
$WORKER doctor --worker-id gpu-host-1 --ssh-key ~/.ssh/mmt_worker_ed25519 --known-hosts ~/.ssh/mmt_known_hosts
$WORKER status --worker-id gpu-host-1
journalctl --user -u mado-tracking-worker@gpu-host-1 -f
```

| Command | What it checks |
| --- | --- |
| `doctor` | Modes of the configuration file and state directory, API reachability, token scopes, and permissions of `~/.ssh`, the private key, and known_hosts. Exit code 1 on problems |
| `status` | Unit state, worker lock, and retained Jobs. Exit code 3 when stopped |
| `journalctl` | Worker log |

Finally, check that **Workers** in Compute shows the worker as online with its version and host name.

## 4. Upgrade

```bash
git -C ~/mado-ml-tracking pull
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker upgrade \
  --worker-id gpu-host-1 --package-spec "$HOME/mado-ml-tracking/python[telemetry]"
```

To install a version from an internal package index, use `--version 0.2.0` instead of `--package-spec`.

`upgrade` installs into the venv the unit uses, then restarts the unit.

- Running Jobs keep running. The unit uses `KillMode=process`, so restarting, stopping, or upgrading the worker does not stop running code, and the restarted worker takes over from its records.
- If `pip` fails, the unit is not restarted.
- If the unit is stopped but a worker started by hand holds the state directory, nothing is done.

### Replace the token

Before the token expires, issue a new one, save it to a file, and run `install` again.

```bash
install -m 600 /dev/null ~/worker-token
read -rsp 'Worker API token: ' TOKEN && printf '%s\n' "$TOKEN" > ~/worker-token && unset TOKEN
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker install \
  --api-url https://tracking.example.internal --worker-id gpu-host-1 \
  --target-ids "<target ID>" --token-file ~/worker-token
rm ~/worker-token
```

Revoke the old token in **Projectのtoken一覧** (Project tokens). Disabling the Service Account with **無効化** (Disable) stops all of its tokens at the next request.

## Run by hand

To try the worker before installing the service, start it in a terminal.

```bash
export MMT_API_URL=https://tracking.example.internal
export MMT_WORKER_ID=gpu-host-1
export MMT_WORKER_TARGET_IDS="<target ID>"
export MMT_WORKER_STATE_DIR="$HOME/.local/state/mmt-worker-manual"
read -rsp 'Worker API token: ' MMT_API_TOKEN
export MMT_API_TOKEN
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker
```

`--once` processes one Job and exits. A second worker started with the same state directory is refused.

## Run with Docker Compose

A worker that only uses SSH targets can also run with the repository's Docker Compose file.

```bash
docker compose --profile worker up -d worker
docker compose --profile worker run --rm worker doctor
```

- Token: `./var/worker-token` (change with `MMT_WORKER_TOKEN_FILE`) is passed as a Docker secret.
- Key and known_hosts: `./var/worker-ssh` (`MMT_WORKER_SSH_DIR`) is mounted read-only at `/home/worker/.ssh`. Register the target's key and known_hosts paths as paths inside the container.
- State: the `worker-state` volume. Removing it loses running Jobs.

## The code receives a Job-scoped token

The worker never gives its own token to the code. Instead, the API server issues a Job-scoped token (starting with `mmtj_`) for each Job, and the worker puts it in the code's `MMT_API_TOKEN` and `MLFLOW_TRACKING_TOKEN`. Both the Python SDK and the MLflow 3 SDK log with it as is.

- It has the current permissions of the person who created the Run. Removing that person from the Project also rejects logging from running code.
- It can write only to the Job's Run (metrics, parameters, tags, logs, input datasets, Artifacts) and to model and dataset versions whose source is that Run.
- It cannot write to other Runs of the Project, issue tokens, change Project settings, or change automation rules. It can read within the same Project, for example the upstream Run's Artifacts.
- It stops working when the Job ends (finished, failed, or canceled).

The token is stored in the worker's state directory (mode 700, files 600). After a worker restart, running Jobs keep using the same token.

## What the code receives

The worker passes these variables to the code. In containers, the paths are paths inside the container.

| Variable or path | Contents |
| --- | --- |
| `MMT_API_URL`, `MMT_API_TOKEN` | API server URL and the Job-scoped token |
| `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN` | Tracking URI and Job-scoped token for the MLflow 3 SDK |
| `MMT_RUN_ID` | The Job's Run. `start_run()` without arguments in the Python SDK logs to it |
| `/mmt/inputs`, `MMT_MODEL_FILE` | Downloaded model weights (read-only) |
| `MMT_PARAMETERS_FILE` | Parameters as JSON |
| `MMT_INPUT_DATASET_DIRS` | JSON mapping each input dataset version to its downloaded directory |
| `MMT_DATASET_VERSIONS_FILE` | Information about input dataset versions |
| `MMT_UPSTREAM_RUN_ID`, `MMT_UPSTREAM_RUN_FILE` | The upstream Run, for [chained rules](/en/models/automation#chain-evaluation-after-inference) |
| `MMT_RESUME_CHECKPOINT_DIR` and others | The checkpoint to resume from ([Resume training](/en/models/checkpoints)) |
| `/mmt/source` | An additional source (containers with a source, read-only) |
| `/mmt/outputs`, `MMT_OUTPUTS_DIR` | Where to write output files |
| `MMT_RESULT_FILE` | Path for `result.json`, the completion declaration of code that does not use the SDK |

### Return results without the SDK

A container without the SDK writes outputs to `/mmt/outputs` and finally writes `result.json`. After the code exits, the worker checks the declaration against the files and saves them as Run Artifacts under `container/<path>`.

```json
{
  "version": 2,
  "complete": true,
  "artifacts": [{"path": "model/weights.bin", "sha256": "<64 hex digits>", "size": 1048576}],
  "metrics": [{"name": "train.loss", "value": 0.12, "step": 100}],
  "models": [{"path": "model/weights.bin"}]
}
```

- `sha256` and `size` must match the files. Write `result.json` after all outputs are written.
- Weights declared in `models` are registered as model versions. Only training and fine-tuning Runs can declare models, and the worker token needs `registry:write`.
- `datasets` entries `{datasetId, path, digest}` register outputs as dataset versions, which is how inference outputs reach evaluation.
- For thousands of output files, list them in a JSON Lines file with one `{"path","sha256","size"}` per line and point to it with `"artifactsManifest": "artifacts.jsonl"`.

| Limit | Value |
| --- | --- |
| Output files | 10000 (`MMT_WORKER_MAX_OUTPUT_FILES` on the worker) |
| `result.json` | 1 MiB |
| Metrics | 1000 points |
| `models`, `datasets` | 16, 64 |

## Disconnects and stopping

- If SSH between the worker and the target drops, the code keeps running on the target. The worker reconnects to the same Job and sends the rest of the log. The same Job is never started twice.
- A restarted worker takes over running Jobs from the records in its state directory. Do not delete the state directory.
- Jobs are stopped only with **停止を要求** (Request stop) in Jobs. The worker sends SIGTERM to the running processes, SIGKILL after 10 seconds, and ends the Job as canceled.
- When a Job's heartbeat stops for 60 seconds, Jobs shows **応答なし** (Not responding). The Job's state and GPU reservation are not changed; check the worker machine before stopping or retrying by hand.
- When a worker does not respond for 120 seconds, **Workers** in Compute shows it as offline. To be notified, select `worker.offline` in a Project notification rule ([Notifications](/en/admin/notifications)).
