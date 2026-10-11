---
title: Native API
description: Authentication, common shapes, errors, and feature groups of the mado ML Tracking native API, and how to get the OpenAPI document (openapi.json).
---

# Native API

mado ML Tracking has two APIs.

| API | Base | Good for |
| --- | --- | --- |
| MLflow 3 compatible API | `/api/mlflow/projects/<Project ID>` | Recording from the official MLflow 3 SDK and MLflow-compatible tools ([Recording from MLflow 3](/en/tracking/mlflow)) |
| Native API | `/api` | The Python SDK (`mado-tracking`), workers, the web UI, and features MLflow lacks (Jobs, automation, promotion policies, the audit log, and more) |

This page describes the native API. From Python, the [Python SDK](/en/tracking/sdk) is usually easier than calling the API directly.

## Authentication

| Method | Used by |
| --- | --- |
| `Authorization: Bearer <API token>` | SDK, scripts, CI, workers |
| Session cookie | The browser (web UI). Changing requests are checked for Origin |

See [API tokens and Service Accounts](/en/admin/tokens) for issuing tokens and scopes. Token requests check both the scopes and the token owner's Project role.

```sh
export MMT_API_URL=https://tracking.example.com
read -rsp 'API token: ' MMT_API_TOKEN
export MMT_API_TOKEN

curl -sS -H "Authorization: Bearer $MMT_API_TOKEN" "$MMT_API_URL/api/projects"
```

Some operations work only with a browser session; with an API token they return 403 `session_required`:

- Issuing and revoking API tokens
- Creating and changing Service Accounts and issuing their tokens
- The global audit log and user management (全体管理, Global administration)

## Common shapes

- JSON keys are camelCase.
- IDs are UUIDs; times are ISO 8601 (UTC).
- Getting or creating one item returns the item itself. Lists have the shape `{items: [...]}`. Lists with more pages return `nextCursor`; pass it as `cursor` in the next request.
- JSON bodies are limited to 4 MiB by default. The exceptions (32 MiB for offline sync, 128 MiB for creating a DatasetVersion) are in the OpenAPI document.
- Artifact content supports HTTP Range requests.

## Errors

Errors have this shape. `error` is a human-readable message; `code` is for programs. Use `code` in your checks.

```json
{"error": "API tokenのscopeが不足しています", "code": "insufficient_scope"}
```

| Status | Common `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_cursor`, `invalid_parameter_value` | Invalid search condition or cursor |
| 401 | `authentication_required`, `invalid_token` | Not signed in; token invalid, revoked, or expired |
| 401 | `identity_sync_required` | An SSO user has not signed in from a browser for 7 days ([Authentik (SSO)](/en/admin/sso)) |
| 403 | `insufficient_scope` | The token lacks a scope |
| 403 | `project_forbidden` | Insufficient Project role, or a Project other than the token's |
| 403 | `session_required` | Only available with a browser session |
| 403 | `job_token_forbidden` | Not allowed for Job tokens |
| 403 | `password_change_required` | The first-login password change is not done |
| 404 | — | The target does not exist or belongs to another Project |
| 409 | `conflict` and others | State conflict (removing the last Admin, acting on a finished Job, archiving a Project with active Jobs (`project_has_active_jobs`), deleting a Project that is not archived (`project_not_archived`), and so on) |
| 413 | `artifact_too_large` | The Artifact exceeds the limit (200 GiB by default) |
| 422 | `invalid_request` and others | Invalid input |
| 429 | `rate_limited` | Login attempt limit. Wait `Retry-After` seconds |
| 503 | `oidc_unavailable` | Authentik is unreachable, so the SSO session cannot be checked |
| 503 | `database_unavailable` | The database is unreachable (`GET /api/health`) |

## Feature groups

The OpenAPI document groups the API by tag.

| Tag | Content |
| --- | --- |
| `system` | Health check (`GET /api/health`) and the OpenAPI document |
| `auth` | Login, sessions, your account |
| `access` | Project members, group grants |
| `tokens` | API tokens, Service Accounts |
| `projects` | Projects, experiments |
| `runs` | Recording, searching, comparing, and resuming Runs |
| `analysis` | Metric series, sweep analysis |
| `media` | Per-step audio, images, video, and tables of Runs |
| `collaboration` | Run descriptions, comments |
| `saved-views`, `reports` | Saved views, shared reports |
| `sync` | Uploading offline records |
| `checkpoints` | Resuming training |
| `sweeps` | Hyperparameter search |
| `registry` | Models, code, datasets, and their versions |
| `automation` | Automation after model registration, and chaining |
| `evaluation`, `promotion` | Comparing evaluations, promotion policies and checks |
| `tasks` | Tasks and launching |
| `artifacts`, `artifact-uploads` | Saving, listing, and reading Artifacts; resumable uploads |
| `execution` | Jobs, Compute targets, workers |
| `worker` | API used only by workers (`worker:execute` tokens) |
| `plugins` | Plugin connections |
| `notifications`, `operations` | Notifications, operations alerts |
| `audit` | Audit log |
| `admin` | Global administration (Projects, storage and directory suggestions, users) |

## OpenAPI (openapi.json)

The authorization, input, output, and error codes of every route are published in OpenAPI 3.1. The MLflow-compatible API is not included (it follows the official MLflow REST API).

- From a running server: get `GET /api/openapi.json` from a signed-in browser or with a token that has the `read` scope.
- From the repository: [docs/openapi.json](https://github.com/aida0710/mado-ml-tracking/blob/main/docs/openapi.json)

```sh
curl -sS -H "Authorization: Bearer $MMT_API_TOKEN" "$MMT_API_URL/api/openapi.json" -o openapi.json
```

You can load the file in Swagger UI, Redoc, or OpenAPI client generators.

The document has application-specific fields:

| Field | Content |
| --- | --- |
| `security` | `sessionCookie` or `bearerToken`. The `bearerToken` value lists the required scopes |
| `x-mmt-access` | The required Project role and scope, and whether only a browser session works |
| `x-mmt-job-token` | Whether Job tokens may call it (`read`, `write`, `forbidden`; `write` means writing only to the token's Run) |
| `x-mmt-error-codes` | Error codes per status |
| `x-mmt-max-body-bytes` | The body limit for routes that differ from the default |

The source of truth for behavior is `docs/api-contract.md` in the repository; `openapi.json` is its machine-readable form. Tests detect differences between the two.
