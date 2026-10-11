---
title: Environment variables
description: Environment variables and defaults of the API server, the preview worker, the worker, the Python SDK, and the Mado plugin.
---

# Environment variables

The API server reads `.env` at the repository root. The template is `.env.example`. `.env` holds credentials, so make it readable only by you with `chmod 600 .env`, and never paste it into repositories or chats.

```sh
cp .env.example .env
chmod 600 .env
```

Restart the API after changing values. If a value is malformed or a setting is missing, the API prints only the setting's name and does not start.

## API server: basics

| Variable | Default | Content |
| --- | --- | --- |
| `MMT_DATABASE_URL` | None (required) | PostgreSQL connection URL. `DATABASE_URL` also works |
| `NODE_ENV` | `development` | `production` in production. HTTPS URLs become mandatory and development features are disabled |
| `HOST` | `127.0.0.1` | Address the API listens on |
| `PORT` | `4182` | Port the API listens on |
| `MMT_PUBLIC_URL` | `http://127.0.0.1:4182` | The URL users open. The SSO callback is built from it |
| `MMT_WEB_ORIGIN` | `http://127.0.0.1:5182` | Origin of the web UI. Also used for links in notifications |
| `MMT_ALLOW_PRIVATE_ORIGINS` | `false` | `true` also allows origins with LAN/VPN private IPs and localhost |
| `MMT_ALLOW_SEED` | `false` | Allows loading sample data. Only with `AUTH_MODE=development` |
| `MMT_ALLOW_LOCAL_EXECUTOR` | `false` | Allows the local executor. Only with `AUTH_MODE=development` |
| `DEVELOPMENT_ADMIN_EMAIL` | `admin@localhost` | Email that becomes a global administrator with the development login |

## Authentication and SSO

See [Authentication and local accounts](/en/admin/auth) and [Authentik (SSO)](/en/admin/sso) for details.

| Variable | Default | Content |
| --- | --- | --- |
| `AUTH_MODE` | `hybrid` | `local`, `oidc`, `hybrid`, `development` |
| `AUTH_SESSION_IDLE_SECONDS` | `28800` (8 hours) | Seconds without activity until a session ends. At least 300 |
| `AUTH_SESSION_ABSOLUTE_SECONDS` | `43200` (12 hours) | Seconds from login until a session ends. At least 3600, and not less than the idle limit |
| `OIDC_ISSUER_URL` | None | Issuer of the Authentik application. Required for `oidc` and `hybrid`. HTTPS |
| `OIDC_CLIENT_ID` | None | Provider client ID. Required for `oidc` and `hybrid` |
| `OIDC_CLIENT_SECRET` | None | Provider client secret |
| `OIDC_ALLOWED_GROUPS` | None | Groups allowed to sign in (comma-separated). Required for `oidc` and `hybrid` |
| `OIDC_ROLE_MAPPING_JSON` | None | Group → global role mapping. Example: `{"mmt-admins":"admin","mmt-users":"user"}` |
| `OIDC_DEFAULT_ROLE` | `user` | Role of users in no mapped group |
| `OIDC_ADMIN_GROUP` | None | Shorthand for `{"<group>":"admin"}`. Without it and the mapping, `mmt-admins` is the administrator group |
| `OIDC_SCOPES` | `openid profile email` | Requested scopes. `openid` is required. Add `offline_access` for refresh tokens |
| `OIDC_LABEL` | `Authentik` | Label of the SSO button on the login screen |
| `OIDC_AUTO_LINK_VERIFIED_EMAIL` | `false` | Whether to link to a local account with the same email automatically |
| `OIDC_ALLOW_INSECURE_HTTP` | `false` | Allows a loopback HTTP issuer (for tests). Not allowed in production |
| `MMT_SESSION_ENCRYPTION_KEY` | None | Key that encrypts Authentik tokens stored with sessions (base64 of 32 bytes). Required for `oidc` and `hybrid` |
| `OIDC_RECHECK_SECONDS` | `60` | Interval (seconds) for rechecking an SSO session's groups |
| `OIDC_TOKEN_SYNC_MAX_AGE_SECONDS` | `604800` (7 days) | Seconds after the last group sync during which SSO users' API tokens work. At least 60 |
| `MMT_TOKEN_MAX_LIFETIME_DAYS` | `365` | Upper limit (days) of a new API token's expiry. 1 to 3650 |

Generate keys in a terminal. Use different values for `MMT_SESSION_ENCRYPTION_KEY` and `MMT_STORAGE_SECRET_KEY`.

```sh
openssl rand -base64 32
```

## Artifacts and storage

Storage settings are described in [Storage](/en/data/storage).

| Variable | Default | Content |
| --- | --- | --- |
| `ARTIFACT_FILESYSTEM_ROOT` | `var/artifacts` under the API's working directory | Location of the filesystem storage. A relative path is resolved from the API's working directory, so use an absolute path in production |
| `S3_BUCKET` | None | When set, the S3 storage from environment variables can be selected |
| `S3_ENDPOINT` | None (AWS S3) | Endpoint of an S3-compatible storage |
| `S3_REGION` | `us-east-1` | Region |
| `S3_PREFIX` | None (bucket root) | Prefix in the bucket. `.env.example` uses `mado-model-tracking` |
| `S3_FORCE_PATH_STYLE` | `false` | Use path-style URLs |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | None | S3 credentials. Without them, the AWS SDK's default provider chain is used |
| `MMT_STORAGE_SECRET_KEY` | None | Key that encrypts in the database the secrets of S3 backends added on the screen (base64 of 32 bytes) |
| `MMT_ARTIFACT_MAX_BYTES` | `214748364800` (200 GiB) | Limit per Artifact |
| `MMT_ARTIFACT_DELETE_GRACE_DAYS` | `7` | Days before a deleted Artifact's content is removed. 0 to 3650 |
| `MMT_UPLOAD_REQUEST_TIMEOUT_MS` | `0` (disabled) | Deadline for a whole upload request |
| `MMT_UPLOAD_IDLE_TIMEOUT_MS` | `120000` | Time before a stalled upload is cut |
| `MMT_MLFLOW_MULTIPART_UPLOADS` | `true` | Accept multipart uploads from the MLflow SDK |
| `MMT_MLFLOW_MULTIPART_DOWNLOADS` | `false` | Do not change. `true` breaks downloads of MLflow SDK 3.17 and later |
| `MMT_UPLOAD_FINALIZE_WAIT_MS` | `100000` | How long completing an MLflow multipart upload waits |

## Notifications

See [Notifications and operations alerts](/en/admin/notifications).

| Variable | Default | Content |
| --- | --- | --- |
| `MMT_NOTIFICATION_*` | None | Webhook URLs and signing keys. Choose any name and register it in the channel |
| `MMT_SMTP_URL` | None | SMTP server URL: `smtp://` (STARTTLS) or `smtps://` |
| `MMT_SMTP_FROM` | None | Sender address. Example: `mado ML Tracking <mmt@example.com>` |
| `NODE_EXTRA_CA_CERTS` | None | Path of an internal CA certificate (PEM), used to verify SMTP servers and webhook destinations |

## Other API server settings

| Variable | Default | Content |
| --- | --- | --- |
| `MMT_CHECKPOINT_KEEP_COUNT` | `5` | Checkpoints listed per Run |
| `MMT_CSV_EXPORT_MAX_ROWS` | `50000` | Maximum rows of a Run search CSV export |
| `MMT_REPORT_SNAPSHOT_MAX_BYTES` | `52428800` | Limit (bytes) of fixed data in one revision of a shared report |
| `MMT_GIT_SSH_KEY_PATH`, `MMT_GIT_KNOWN_HOSTS_PATH` | None | Private key and known_hosts (absolute paths) for loading SSH Git repositories into the editor. Set both |
| `MMT_MADO_PLUGIN_TOKEN` | None | Example secret for connecting to the Mado plugin. The variable name is given when registering the plugin ([Plugins and Mado integration](/en/admin/plugins)) |

## Preview worker

Settings of the worker that renders previews of long audio and video (`npm run preview-worker -w @mmt/api`, or the compose `preview` service). Database and storage settings use the same values as the API server.

| Variable | Default | Content |
| --- | --- | --- |
| `MMT_PREVIEW_FFMPEG_PATH` | `ffmpeg` | Path of ffmpeg |
| `MMT_PREVIEW_FFPROBE_PATH` | `ffprobe` | Path of ffprobe |
| `MMT_PREVIEW_POLL_INTERVAL_MS` | `5000` | Interval for looking for Artifacts to process |
| `MMT_PREVIEW_TOOL_TIMEOUT_MS` | `1800000` (30 minutes) | Limit of one ffmpeg or ffprobe run. Up to 40 minutes |
| `MMT_PREVIEW_WORK_DIR` | The OS temporary directory | Where content is placed temporarily. Needs room for the largest Artifact |

## Worker

Settings of `mado-tracking-worker`. When installed with `install`, they are written to `~/.config/mado-tracking-worker/<worker-id>.env`.

| Variable | Default | Content |
| --- | --- | --- |
| `MMT_API_URL` | None (required) | URL of the API server. Must also be reachable from Compute targets |
| `MMT_API_TOKEN` | None (required) | Service Account token |
| `MMT_API_TOKEN_FILE` | None | File to read the token from (for containers). `MMT_API_TOKEN` wins if set |
| `MMT_WORKER_ID` | None (required) | Worker ID. Keep the same value across restarts |
| `MMT_WORKER_TARGET_IDS` | None (all allowed) | Compute target IDs to serve (comma-separated) |
| `MMT_WORKER_STATE_DIR` | `~/.local/state/mado-tracking-worker/<hash of the ID>` | Directory for the journal of running Jobs |
| `MMT_WORKER_MAX_OUTPUT_FILES` | `10000` | Limit of output files collected from one Job. 1 to 1000000 |
| `MMT_ALLOW_LOCAL_EXECUTOR` | None | `true` enables the local executor (development; the API must allow it too) |

With Docker Compose, `MMT_WORKER_TOKEN_FILE`, `MMT_WORKER_SSH_DIR`, `MMT_WORKER_UID`, `MMT_WORKER_GID`, and `MMT_WORKER_API_URL` are also used ([Worker](/en/compute/worker)).

## Python SDK

| Variable | Default | Content |
| --- | --- | --- |
| `MMT_API_URL` | None | URL of the API server |
| `MMT_API_TOKEN` | None | API token |
| `MMT_OFFLINE_DIR` | `~/.local/share/mado-tracking/offline` | Directory for offline records |

## Variables passed to running code

The worker passes these variables to a Job's code. The code only reads them; you do not set them yourself.

| Variable | Content |
| --- | --- |
| `MMT_API_URL`, `MMT_API_TOKEN`, `MLFLOW_TRACKING_TOKEN` | API URL and the Job token |
| `MMT_PROJECT_ID`, `MMT_EXPERIMENT_ID`, `MMT_RUN_ID`, `MMT_JOB_ID`, `MMT_JOB_KIND` | IDs and kind of the Run being executed |
| `MMT_JOB_CONTEXT_FILE` | JSON with the Job, Run, parameters, model version, input datasets, and more |
| `MMT_PARAMETERS_FILE`, `MMT_PARAMETERS_JSON` | Parameters |
| `MMT_MODEL_VERSION_FILE`, `MMT_MODEL_VERSION_ID` | The model version to use |
| `MMT_DATASET_VERSIONS_FILE`, `MMT_INPUT_DATASET_VERSION_IDS`, `MMT_INPUT_DATASET_DIRS` | Input dataset versions and the directories holding their content |
| `MMT_UPSTREAM_RUN_ID`, `MMT_UPSTREAM_RUN_FILE` | The upstream Run (only when there is one) |
| `MMT_RESUME_CHECKPOINT_DIR`, `MMT_RESUME_STEP`, `MMT_RESUME_CHECKPOINT_FILE` | The checkpoint to resume from (only when resuming) |
| `MMT_OUTPUTS_DIR`, `MMT_RESULT_FILE` | The output directory and the path of `result.json` |

## Mado plugin

The Mado plugin is a separate service with its own `.env`. See "Plugin `.env`" in [Plugins and Mado integration](/en/admin/plugins).
