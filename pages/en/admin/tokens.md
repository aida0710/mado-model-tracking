---
title: API tokens and Service Accounts
description: Personal API tokens, Service Accounts that belong to no person, scopes, expiry and revocation, and the Job tokens issued for each Job.
---

# API tokens and Service Accounts

The SDK, MLflow, workers, and CI authenticate to the API with API tokens. There are three kinds.

| Kind | Owner | Where it is issued | Good for |
| --- | --- | --- | --- |
| Personal API token | The signed-in user | **自分のAPI token** (My API tokens) in **Settings**, or the MLflow 3 connection card | Recording Runs from your own PC or notebook |
| Service Account token | A Service Account (not tied to a person) | **Service Accounts** in **Settings** | Long-running workers, automation, CI |
| Job token | The creator of the Run | Workers receive one automatically for each Job | Recording to the Run from the running code. Nobody issues these by hand |

The token value is shown only once, when it is issued. The database keeps only a hash and the first 12 characters, and no list shows the value.

## Scopes

Scopes decide what a token can do. Scopes beyond the owner's Project role cannot be selected.

| Scope | Allows | Role the owner needs |
| --- | --- | --- |
| `read` | Reading | Viewer |
| `runs:write` | Creating and recording Runs | Editor |
| `registry:write` | Registering models and datasets | Editor |
| `artifacts:write` | Saving Artifacts | Editor |
| `jobs:write` | Starting and canceling Jobs | Editor |
| `worker:execute` | Running Jobs as a worker | Admin |
| `admin` | Managing the Project. Includes every other scope | Admin |

Besides the scopes, every token request checks the owner's current effective role. If the owner is removed from the Project or loses a role, the affected operations return 403 even without revoking the token.

## Expiry

Every new token has an expiry. On the screen you choose 7, 30, 90 (default), or 365 days. The upper limit is the API server's `MMT_TOKEN_MAX_LIFETIME_DAYS` (default 365 days); a token issued through the API without an expiry gets that limit. An expiry beyond the limit returns 422 `token_lifetime_exceeded`.

An expired token returns 401. Issue a new token and replace the old one before it expires.

## Issue a personal API token

1. Open the Project's **Settings** and click **API tokenを発行** (Issue API token) under **自分のAPI token**.
2. Enter a name, scopes, and expiry, and click **保存** (Save).

| Field | Example |
| --- | --- |
| Name | `laptop-notebook` (a name that says where it is used) |
| Scope | `read` and `runs:write` to record Runs; add `artifacts:write` to save Artifacts |
| Expiry | `90日` (90 days) |

3. Click **コピー** (Copy) and store the token somewhere safe. It is never shown again after you close the dialog.

Tokens issued on the screen are limited to that Project. For MLflow 3, you can also use **このProject用のAPI tokenを発行** (Issue an API token for this Project) in the **MLflow 3から接続** (Connect from MLflow 3) card; it shows example environment variables after issuing.

In a terminal, type the token into an environment variable instead of writing it in command arguments or files:

```sh
export MMT_API_URL=https://tracking.example.com
read -rsp 'API token: ' MMT_API_TOKEN
export MMT_API_TOKEN
```

Check that the token works with the following command. It prints the token's scopes and Project.

```sh
curl -sS -H "Authorization: Bearer $MMT_API_TOKEN" "$MMT_API_URL/api/auth/token"
```

### SSO users' tokens stop after 7 days

Tokens of users who sign in with SSO stop with 401 `identity_sync_required` when 7 days (`OIDC_TOKEN_SYNC_MAX_AGE_SECONDS`) have passed since the last browser login. This is how removal from an Authentik group is noticed. Signing in once in a browser makes the same tokens work again ([Authentik (SSO)](/en/admin/sso)).

## Service Accounts

A Service Account is an account that belongs to one Project and to no person. Its tokens keep working when the person who issued them leaves the Project, and the 7-day limit for SSO users does not apply.

![The Service Accounts and Project token list sections](/images/admin-service-accounts.png)

### Create a Service Account

A Project Admin does this in the browser (API tokens cannot create Service Accounts).

1. Click **Service Accountを作成** (Create Service Account) under **Service Accounts** in **Settings**.
2. Enter the following and save.

| Field | Example |
| --- | --- |
| Name | `gpu-host-1-worker` (unique in the Project, up to 200 characters) |
| Description | `Worker on GPU server 1` |
| Role | `Admin` for a worker or an automation owner, `Viewer` for read-only CI |

3. Click **API tokenを発行** (Issue API token) on the new row, choose a name, scopes, and expiry, and save. Note the token that is shown.

![Issuing a token for a Service Account](/images/admin-token-dialog.png)

Only scopes up to the Service Account's role can be chosen. `worker:execute` can be issued only to Service Accounts with the Admin role.

Typical scopes by use:

| Use | Role | Scopes |
| --- | --- | --- |
| Worker | Admin | `read`, `worker:execute`, `artifacts:write`; add `registry:write` to register output models and datasets |
| Owner of automation rules and promotion policies | Admin | No token needed (ownership is only transferred) |
| Recording Runs from CI | Editor | `read`, `runs:write`, `artifacts:write` |

See [Worker](/en/compute/worker) for installing a worker, and [Automation](/en/models/automation) for transferring automation rule ownership to a Service Account.

### Stop or change

- Stop temporarily: click **無効化** (Disable) on the row. All tokens of the Service Account return 401 from the next request. **有効化** (Enable) makes the same tokens work again.
- Change the role: choose a new role with **変更** (Change). After lowering the role, operations above the new role return 403.
- Stop one token: revoke it in the **Projectのtoken一覧** (Project token list) below.

Service Accounts also appear in the global Users tab as "Service Account", but they cannot sign in and cannot be made global administrators.

## Revoke a token

- Your own tokens: click **失効** (Revoke) under **自分のAPI token** in **Settings**, or under the same heading on the **アカウント** (Account) page.
- Project tokens: in **Projectのtoken一覧**, a Project Admin sees the tokens of every user and Service Account limited to the Project, and can revoke them with **失効**. The list shows the owner, the first 12 characters, scopes, expiry, and last use (updated every 5 minutes).

A revoked token returns 401 from the next request and cannot be restored. Issuing and revoking are recorded in the audit log as `token.create` and `token.revoke`.

### Legacy tokens

Tokens marked **旧形式** (legacy) in the list are service tokens owned by a person. They stop when the owner leaves the Project, so replace them with Service Account tokens. Legacy tokens of the running Playground are to be replaced by their expiry (2026-10-15).

## Job tokens

For each Job, the worker receives a token valid only for that Job (starting with `mmtj_`) and passes it to the running code as `MMT_API_TOKEN` and `MLFLOW_TRACKING_TOKEN`. The worker's own token is never passed to the code. Nobody issues or manages Job tokens by hand.

- Permissions follow the Run creator's current effective role. The scopes are `read`, `runs:write`, `artifacts:write`, and `registry:write`.
- The token can write only to the target Run (metrics, params, tags, logs, input datasets, Artifacts), model and dataset versions whose source is that Run, the Run's Logged Models, and the creation of the output Model. Writing to other Runs in the Project, issuing tokens, Project settings, and automation rules return 403 `job_token_forbidden`.
- It can read anything in the same Project, for example to fetch an upstream Run's Artifacts.
- When the Job ends (finished, failed, or canceled), the token returns 401.

See [Worker](/en/compute/worker) for using it from the running code.

## MLflow Basic authentication

For tools that only accept a username and password, the MLflow-compatible API (`/api/mlflow/...`) also accepts Basic authentication. Put the API token in the password; the username may be empty. Local account passwords are not accepted.

```sh
export MLFLOW_TRACKING_USERNAME=token
read -rsp 'API token: ' MLFLOW_TRACKING_PASSWORD
export MLFLOW_TRACKING_PASSWORD
```

Basic authentication to the native API returns 401 `basic_auth_unsupported`. See [Recording from MLflow 3](/en/tracking/mlflow) for the MLflow connection.
