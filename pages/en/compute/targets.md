---
title: Compute targets
description: Register GPU machines that run Jobs as Compute targets. SSH settings, GPU selection, preparing Docker, Singularity and Apptainer, and connection checks run by the worker.
---

# Compute targets

![Compute targets and workers](/images/compute-targets.png)

A Compute target is a machine that runs Jobs. It registers the SSH destination, available GPUs, supported runtimes (Python, Docker, Singularity, Apptainer), and a working directory. The worker connects to the target and runs Jobs; the API server never connects to targets.

```text
API server ← worker (holds the SSH key and known_hosts) → Compute target (GPU machine)
```

The web UI is in Japanese. Labels are shown as they appear on screen, followed by an English translation.

## When to use it

- Run Task and automation Jobs on GPU machines in your lab or company
- Reserve GPUs one by one so that Jobs do not compete for the same GPU
- Run code with dependencies packed into a Docker image or SIF file
- Check SSH, Python, Docker, and GPUs in one step before the first Job

## Prepare the target

The example uses an Ubuntu GPU machine. Open a terminal on the target and run the following.

### Install Python and Git

The target needs Python 3.11 or later for the supervisor the worker sends. The Python runtime creates a venv per Job and installs dependencies.

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip git
python3 --version
```

If `python3 --version` is older than 3.11, install Python 3.11 or later separately and enter its path as the target's Python executable.

### For Docker

```bash
sudo apt-get install -y docker.io
sudo usermod -aG docker "$USER"   # add the SSH user to the docker group
```

The group change takes effect at the next login. Log in again over SSH and check that `docker version` shows the Server version.

- The worker starts containers with `--network host`. Inside the container, `127.0.0.1` is the target itself.
- Read-only mounts require Linux kernel 5.12 or later. Check with `uname -r`.
- Rootless Docker and user namespace remapping have not been tested.

To use GPUs with Docker, install the NVIDIA Container Toolkit in addition to the NVIDIA driver.

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### For Apptainer

```bash
sudo add-apt-repository -y ppa:apptainer/ppa
sudo apt-get update
sudo apt-get install -y apptainer
apptainer --version
```

Singularity and Apptainer need `exec` with `--cleanenv`, `--containall`, `--no-home`, `--no-mount`, `--no-eval`, `--pwd`, and `--nv` for GPUs. Older versions fail the connection check.

### Allow SSH from the worker

The SSH private key and known_hosts live on the worker machine; the target registration only stores their paths. Open a terminal on the worker machine and run the following, replacing `gpu-host-1.example.internal` and `mmt` with the target's host name and SSH user.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/mmt_worker_ed25519 -N ''
chmod 600 ~/.ssh/mmt_worker_ed25519
ssh-copy-id -i ~/.ssh/mmt_worker_ed25519.pub mmt@gpu-host-1.example.internal
ssh-keyscan -p 22 gpu-host-1.example.internal > ~/.ssh/mmt_known_hosts
ssh-keygen -lf ~/.ssh/mmt_known_hosts
```

Compare the fingerprint from the last command with the output of `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the target. The worker never accepts unknown or changed host keys (`StrictHostKeyChecking=yes`).

## Register the target

![The Compute target dialog](/images/compute-target-dialog.png)

Global administrators register and change targets.

1. Open Compute and press **Compute targetを登録** (Register Compute target).
2. Fill in the fields.

| Field | Example | Meaning |
| --- | --- | --- |
| **名前** (Name) | `gpu-host-1` | Shown on screen and in Task choices |
| **Executor** | SSH | Normally SSH. Local (development only) appears only in development mode |
| **Host**, **Port** | `gpu-host-1.example.internal`, `22` | SSH destination of the target |
| **SSHユーザー** (SSH user) | `mmt` | User to connect as |
| **SSH鍵のパス** (SSH key path) | `/home/worker/.ssh/mmt_worker_ed25519` | Path of the private key on the worker machine |
| **known_hostsのパス** (known_hosts path) | `/home/worker/.ssh/mmt_known_hosts` | Path of known_hosts on the worker machine |
| **作業ディレクトリ** (Working directory) | `/data/mmt-jobs` | Where Job files go on the target. The SSH user must be able to write here |
| **Python実行パス** (Python executable) | `python3` | Python 3.11 or later on the target |
| **対応Runtime** (Runtimes) | Python, Docker | Runtimes this target can run |
| **GPU ID（1行に1件）** (GPU IDs, one per line) | `0`<br>`1` | GPU numbers Jobs may use. Empty for a CPU-only target |
| **同時実行数** (Concurrent Jobs) | `2` | Maximum Jobs running at once |
| **データセットの転送** (Dataset transfer) | Relayed by the worker | How input datasets are fetched (below) |
| **データセットのcache上限（GiB）** (Dataset cache limit) | `100` | Limit of the dataset cache on the target |

3. Press **保存** (Save) and check that the target appears in the list.
4. Check the target with **接続を確認** (Check connection), described below.

Connection details such as key paths are not shown to ordinary viewers.

### GPU assignment

When a Task or automation rule selects GPU IDs, those GPUs are reserved in the app for the Job and not given to other Jobs. Without GPU IDs the Job runs on CPU only.

- Docker receives only the reserved GPUs with `--gpus device=...`; CUDA numbers inside the container start from `0`.
- Singularity and Apptainer use `--nv` and `CUDA_VISIBLE_DEVICES` to limit which GPUs CUDA sees. This does not isolate the devices themselves.
- Reservations only apply between Jobs of this app. They do not stop people using the GPU over SSH or another scheduler. On shared machines, register GPUs and a working directory dedicated to this app.
- GPUs of Jobs whose state cannot be confirmed are not released automatically.

### Input dataset transfer

| Setting | Behavior | Suitable when |
| --- | --- | --- |
| **workerが中継する** (Relayed by the worker, default) | The worker downloads from the API and sends one tar to the target | The GPU machine cannot reach the API server |
| **targetがAPIから直接取得する** (Target downloads from the API) | The target downloads with the Job-scoped token | The target reaches the API and relaying is slow |

Downloaded datasets are cached in `.mmt-cache/datasets/` under the working directory and reused by later Jobs. When the cache exceeds the limit, the least recently used entries are removed, except those used by running Jobs. See [Datasets](/en/data/datasets) for dataset versions.

### Change or disable a target

Use **Compute targetを編集** (Edit Compute target). While queued or running Jobs reference the target, the destination, runtimes, GPUs, and dataset settings cannot be changed; save after the Jobs end.

Clearing **有効** (Enabled) removes the target from new assignments. The worker keeps managing running Jobs.

## Check the connection

![Connection check results](/images/compute-target-check.png)

Before the first Job, use **接続を確認** to check that the target is ready. The worker that handles the target runs the check with its own SSH key.

1. Press **接続を確認** on the target's row. The **接続確認** (Connection check) panel opens below.
2. Press **接続を確認** at the top right of the panel. The status changes when a worker picks up the check.
3. Read the result of each item. Failing items show a fix in the **対処** (Fix) column.

| Item | What is checked |
| --- | --- |
| SSH connection | The key and known_hosts work |
| Python | The Python executable is 3.11 or later |
| venv, pip | A per-Job venv can be created and packages installed |
| git | Git sources can be fetched |
| Docker | The CLI exists and the daemon is reachable; permission problems and a stopped daemon are reported separately |
| Apptainer, Singularity | The CLI exists and supports the required options |
| GPU (nvidia-smi) | Index, name, and memory of GPUs reported by `nvidia-smi` |
| Working directory | Writable by the SSH user, and free space |
| API reachability | The target reaches the API server |

**OK** means usable, **NG** means Jobs will fail as is, and **なし** (none) means an optional tool such as a runtime or Git is not installed.

GPUs and runtimes found by the check are offered in **設定の候補** (Suggested settings). The target's GPU IDs and runtimes change only when you select candidates and press **選んだ候補を保存** (Save selected).

The check leaves nothing on the target, not even the working directory.

### When the check does not finish

| Message | Cause and fix |
| --- | --- |
| No worker claimed the check within 5 minutes | No worker handles this target. Check that the target ID is in the worker's `MMT_WORKER_TARGET_IDS` (`--target-ids` of `install`) |
| No result arrived from the worker | The worker stopped during the check. Check the worker log |
| SSH connection NG (key permissions) | The key or known_hosts is missing on the worker machine, or the key is not mode 600. Run `mado-tracking-worker doctor` on the worker machine |
| API reachability NG | The target cannot reach the worker's `MMT_API_URL`, which Jobs need for logging. Check the route and URL |

A worker without `MMT_WORKER_TARGET_IDS` still processes Jobs but never picks up connection checks.

## Workers

**Workers** in Compute shows each worker connected to the Project with its status, version, host name, last response, and number of Jobs. A worker without a response for 120 seconds is shown as offline. See [Install and run the worker](/en/compute/worker).

## Permissions

| Action | Required role |
| --- | --- |
| View targets and workers | viewer or higher |
| Register, change, enable, or disable targets; run connection checks | Global administrator |
