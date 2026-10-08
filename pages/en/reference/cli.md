---
title: CLI
description: The mado-tracking command (uploading offline records) and mado-tracking-worker (running, installing, upgrading, and diagnosing workers) in the Python SDK, and the API server's management commands.
---

# CLI

The Python SDK (the `mado-tracking` package) contains two commands.

| Command | Where | Content |
| --- | --- | --- |
| `mado-tracking` | Machines that run training | Sends Runs recorded offline to the API |
| `mado-tracking-worker` | Worker hosts | Runs, installs into systemd, upgrades, checks, and diagnoses the worker |

Management commands of the API server are listed under "API server commands" below.

## Install

Python 3.11 or later is required. Install into a virtual environment:

```sh
python3 -m venv ~/.venvs/mado-tracking
~/.venvs/mado-tracking/bin/pip install 'mado-tracking[telemetry]'
~/.venvs/mado-tracking/bin/mado-tracking --help
```

`[telemetry]` also installs `psutil` and `nvidia-ml-py` for recording GPU and CPU usage. To install from an internal index or a wheel file, replace `mado-tracking[telemetry]` with that URL or path. See [Python SDK](/en/tracking/sdk) for SDK usage.

## mado-tracking

### mado-tracking sync

Sends Runs recorded where the API was unreachable (offline records) to the API. If it fails midway, running it again continues from where it stopped.

```sh
export MMT_API_URL=https://tracking.example.com
read -rsp 'API token: ' MMT_API_TOKEN
export MMT_API_TOKEN

mado-tracking sync
mado-tracking sync --dry-run
mado-tracking sync ~/runs/offline --project-id <Project ID> --prune
```

| Argument or option | Content |
| --- | --- |
| `DIR` (repeatable) | An offline directory or one Run's directory. Defaults to `MMT_OFFLINE_DIR`, then `~/.local/share/mado-tracking/offline` |
| `--dry-run` | Shows what would be sent without contacting the API |
| `--project-id` | Sends only Runs of this Project |
| `--prune` | Deletes a Run's records once fully sent |

The token needs the `runs:write` and `artifacts:write` scopes. One line is printed per Run:

```text
<Run ID>  completed  batches=3 artifacts=2 present=0 media=0
```

| Second column | Meaning |
| --- | --- |
| `completed` | Fully sent (`already synced` means it was sent before) |
| `partial` | Records were sent, but the Run has no final status yet. The Run stays running |
| `recording` | Skipped because the Run is still being recorded |
| `failed` | Sending failed. Running again continues from where it stopped |
| `pending` | With `--dry-run`: something remains to be sent |
| `filtered` | Skipped because the Run belongs to a Project other than `--project-id` |

| Exit code | Meaning |
| --- | --- |
| 0 | Everything was sent (also when there was nothing to send) |
| 1 | At least one Run failed |
| 2 | Configuration error (for example `MMT_API_URL` or `MMT_API_TOKEN` is missing) |

## mado-tracking-worker

The worker is a process separate from the API server. It receives Jobs and runs them on SSH targets or in containers. The installation procedure is in [Worker](/en/compute/worker); this section lists the commands.

```sh
mado-tracking-worker run [--once]
mado-tracking-worker install --api-url <URL> --worker-id <ID> [options]
mado-tracking-worker upgrade --worker-id <ID> (--version <version> | --package-spec <spec>)
mado-tracking-worker status --worker-id <ID> [--json]
mado-tracking-worker doctor [--worker-id <ID>] [--ssh-key <path>] [--known-hosts <path>]
```

`install`, `upgrade`, `status`, and `doctor` accept `--systemd-user` (default; a user unit for this account) or `--systemd-system` (a system unit; run as root).

### run

Runs the worker in the foreground. Running `mado-tracking-worker` with no arguments also means `run`. Settings come from environment variables (`MMT_API_URL`, `MMT_API_TOKEN`, `MMT_WORKER_ID`, `MMT_WORKER_TARGET_IDS`, `MMT_WORKER_STATE_DIR`, and others; see "Worker" in [Environment variables](/en/reference/environment)).

| Option | Content |
| --- | --- |
| `--once` | Recovers retained Jobs, or claims one Job and processes it to the end, then exits |

In containers, the token is read from the file in `MMT_API_TOKEN_FILE`.

### install

Writes the environment file and the systemd unit, then starts it with `systemctl enable --now`. The token is never taken as an argument: it is asked with hidden input in a terminal, read from standard input in a pipe, or read from the file given with `--token-file`.

```sh
~/.local/share/mado-tracking-worker/venv/bin/mado-tracking-worker install \
  --api-url https://tracking.example.com \
  --worker-id gpu-host-1 \
  --target-ids "<Compute target ID>"
loginctl enable-linger "$USER"
```

| Option | Content |
| --- | --- |
| `--api-url` (required) | URL of the API server |
| `--worker-id` (required) | Worker ID: letters, digits, `.`, `_`, `-`, up to 64 characters. Keep the same value across restarts and upgrades |
| `--target-ids` | Compute target IDs to serve (comma-separated). Omit for all allowed targets |
| `--state-dir` | Directory for the journal of running Jobs. Reuse it when reinstalling |
| `--token-file` | File to read the token from |
| `--python` | Python of the worker's virtual environment (default: the running Python) |
| `--service-user` | Account that runs a system unit |

A user unit writes `~/.config/mado-tracking-worker/<worker-id>.env` (mode 600) and `~/.config/systemd/user/mado-tracking-worker@.service`. To keep it running after logout, `loginctl enable-linger` is needed. A system unit uses `/etc/mado-tracking-worker/<worker-id>.env` and `/var/lib/mado-tracking-worker/<worker-id>`.

### upgrade

Installs a new version into the unit's virtual environment with `pip install --upgrade` and restarts the unit. Running Jobs keep running, and the restarted worker takes them over from its journal. If pip fails, the unit is not restarted.

```sh
mado-tracking-worker upgrade --worker-id gpu-host-1 --version 0.2.0
mado-tracking-worker upgrade --worker-id gpu-host-1 --package-spec /path/to/mado_tracking-0.2.0-py3-none-any.whl
```

### status

Shows the unit state, the worker lock, and retained Jobs. `--json` prints JSON. The exit code is 3 when the unit is not running (as with `systemctl status`).

```sh
mado-tracking-worker status --worker-id gpu-host-1
```

### doctor

Checks the setup. The exit code is 1 if there is an error.

```sh
mado-tracking-worker doctor --worker-id gpu-host-1 --ssh-key ~/.ssh/gpu_key --known-hosts ~/.ssh/known_hosts
```

It checks:

- The permissions of the environment file and the state directory
- Reachability of the API server (`/api/health`)
- The token's scopes (`GET /api/auth/token`; Job tokens are not accepted)
- `~/.ssh`, private keys (no group or other permissions), and known_hosts (not writable by group or other)

With `--worker-id` it reads the installed environment file; without it, the current environment variables.

## API server commands

Run these in the API server's repository. With Docker Compose, prefix them with `docker compose run --rm api`.

| Command | Content |
| --- | --- |
| `npm run db:migrate` | Applies database migrations. Run it on every update, before replacing the API |
| `npm run bootstrap-admin -w @mmt/api` | Creates the initial administrator or recovers an administrator ([Authentication and local accounts](/en/admin/auth)) |
| `npm run preview-worker -w @mmt/api` | Runs the worker that renders previews of long audio and video. Needs ffmpeg and ffprobe |
| `npm run openapi:generate` | Regenerates `docs/openapi.json` (for development) |
| `npm run db:seed` | Loads sample data for checking. Only with `AUTH_MODE=development` and `MMT_ALLOW_SEED=true` |
