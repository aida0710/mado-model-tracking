---
title: Troubleshooting
description: What to check when the API does not start, SSO login fails, tokens return 401 or 403, notifications do not arrive, or plugins and workers stop.
---

# Troubleshooting

## The API does not start

If a setting is wrong, the API prints only the names of missing or malformed settings and stops. Values are never printed.

```text
Invalid configuration: OIDC_RECHECK_SECONDS
MMT_SESSION_ENCRYPTION_KEY is required when AUTH_MODE=hybrid
```

| Message | Fix |
| --- | --- |
| `MMT_DATABASE_URL or DATABASE_URL is required` | Put the database URL in `.env` |
| `OIDC_ISSUER_URL and OIDC_CLIENT_ID are required when AUTH_MODE=...` | Add the Authentik settings, or use `AUTH_MODE=local` |
| `MMT_SESSION_ENCRYPTION_KEY is required ...`, `... must be base64 of 32 bytes` | Set a value generated with `openssl rand -base64 32` |
| `OIDC issuer requires HTTPS ...` | Use an HTTPS issuer URL |
| `Production URLs require HTTPS` | With `NODE_ENV=production`, make `MMT_PUBLIC_URL` and `MMT_WEB_ORIGIN` HTTPS |
| `Development authentication is forbidden in production` | In production, set `AUTH_MODE` to `local`, `oidc`, or `hybrid` |
| `AUTH_SESSION_IDLE_SECONDS must not exceed AUTH_SESSION_ABSOLUTE_SECONDS` | Make the idle limit no longer than the absolute limit |
| `MMT_GIT_SSH_KEY_PATH and MMT_GIT_KNOWN_HOSTS_PATH must be set together` | Set both or remove both |

The API also refuses to start when `OIDC_ALLOWED_GROUPS` is empty, when `OIDC_ROLE_MAPPING_JSON` contains a role other than `admin` and `user`, or when `OIDC_ADMIN_GROUP` and the mapping disagree on the admin group. Setting only one of `MMT_SMTP_URL` and `MMT_SMTP_FROM` also stops it.

If it stops after an update, check for newly required settings. `MMT_SESSION_ENCRYPTION_KEY` is required from the version with SSO session rechecks, and `OIDC_ALLOWED_GROUPS` from the version with group-based login.

## Cannot sign in with SSO

Users get a 401 without the reason. The reason is in `details.reason` of the audit action `auth.oidc.denied`, and in a one-line JSON on the API's standard error (`{"event":"oidc_login_denied","reason":...}`). A global administrator can open this URL in a signed-in browser:

```text
https://tracking.example.com/api/audit-events?action=auth.oidc.denied
```

| `reason` | Meaning | Fix |
| --- | --- | --- |
| `group_not_allowed` | Not in any group of `OIDC_ALLOWED_GROUPS` | Add the user to a group in Authentik. Also check that the ID token contains `groups` |
| `email_not_verified` | `email` is missing or `email_verified` is not true | Mark the email as verified in Authentik and emit `email_verified` in the scope mapping |
| `user_disabled` | The user is disabled in this application | A global administrator enables the user in **全体管理** (Global administration) → **ユーザー** (Users) |
| `last_admin` | The sync would leave no active global administrator | Prepare another global administrator first (a local administrator is fine) |
| `privileged_link_required` | A privileged local account has the same email | Not linked automatically. A global administrator checks the local account's permissions |
| `service_account` | Tried to sign in as a Service Account | Service Accounts cannot sign in |

If the audit log has a failed `auth.login` with `details.reason` `invalid_oidc_state`, or standard error shows `oidc_authentication_failed`, the cause is communication with Authentik, too much time since the login screen was opened, or the callback opened in another browser. Start over from the login. If it still fails, check that the Authentik redirect URI exactly matches `<MMT_PUBLIC_URL>/api/auth/callback`.

## Suddenly sent back to the login screen

The SSO session recheck may have ended the session. Check the `reason` of the audit action `auth.oidc.recheck`.

| `reason` | Meaning | Fix |
| --- | --- | --- |
| `group_not_allowed` | Removed from the allowed groups | Check group membership. If UserInfo has no `groups`, everyone gets this |
| `idp_session_revoked` | Authentik refused the tokens (signed out of Authentik, and so on) | Sign in again |
| `reauthentication_required` | The access token expired without a refresh token | Add `offline_access` to `OIDC_SCOPES` and the provider |

## Authentik unreachable (503 `oidc_unavailable`)

The API server cannot reach Authentik, so the SSO session's permissions cannot be checked. The session is kept; once Authentik is back, the same session continues. Check that the API server can connect to the issuer URL.

If Authentik will be down for a long time, switch to `AUTH_MODE=hybrid` and sign in with the local administrator.

While Authentik is unreachable, signing out also returns 503 for SSO sessions whose last check is older than `OIDC_RECHECK_SECONDS`. Even if you cannot sign out, the session cannot be used for any operation. Wait until Authentik is back or the session expires.

## Stuck on the password change screen

The initial administrator, and accounts whose password an administrator reset, cannot use other screens until the password is changed (403 `password_change_required`). Change to a password of 12 to 1024 bytes that differs from the current one.

If the administrator's password is lost, run `npm run bootstrap-admin -w @mmt/api` in a terminal on the API server to reset it.

## "Attempt limit reached"

The login attempt limit was exceeded (429 `rate_limited`). Wait for the `Retry-After` seconds in the response, then try again. The limits are under "Passwords" in [Authentication and local accounts](/en/admin/auth).

## API tokens return 401 or 403

| Response | Cause | Fix |
| --- | --- | --- |
| 401 `invalid_token` | The token is invalid, revoked, or expired, or the owning user or Service Account is disabled | Issue a new token. Check the Service Account's status |
| 401 `identity_sync_required` | An SSO user has not signed in from a browser for 7 days | Sign in once in a browser; the same token works again. Use a Service Account token for long-running work |
| 403 `insufficient_scope` | The token lacks a scope | Issue a token with the needed scopes |
| 403 `project_forbidden` | The owner's Project role is insufficient, or the Project differs from the token's | Check the role, and whether the owner left a group |
| 403 `session_required` | A browser-only operation (issuing tokens, Service Accounts, the global audit log, and so on) | Use the screen |
| 403 `job_token_forbidden` | Not allowed for Job tokens | Check what running code may do ([API tokens and Service Accounts](/en/admin/tokens)) |
| 401 `basic_auth_unsupported` | Basic authentication on the native API | Use a Bearer token. Basic authentication works only on the MLflow-compatible API |

Check a token's scopes and Project with:

```sh
curl -sS -H "Authorization: Bearer $MMT_API_TOKEN" "$MMT_API_URL/api/auth/token"
```

## Browser actions return 403 `invalid_origin`

The URL you opened differs from the allowed origins. To use LAN or VPN IP addresses, set `MMT_ALLOW_PRIVATE_ORIGINS=true`; to use a DNS name, set `MMT_WEB_ORIGIN` and `MMT_PUBLIC_URL` to that URL. Then restart the API.

## Cannot change Project permissions (409)

If the screen says the change would leave the Project without an Admin, you are removing the last Admin. Grant Admin to another member or group first. If disabling or demoting a global administrator returns 409 `last_global_admin`, prepare another global administrator first.

## Notifications do not arrive

1. Check that the channel's **送信設定** (Delivery settings) under **通知** in **プロジェクト設定** (Project settings) shows configured. If not, the variable is missing from the API server's `.env`, or the API was not restarted.
2. Use **テスト送信** (Send test) to check that sending works right now.
3. Check the status and failure reason in **直近の送信履歴** (Recent deliveries). What to check for each reason is under "Delivery and failures" in [Notifications and operations alerts](/en/admin/notifications).
4. Check that the rule is enabled and its events and conditions match. Worker offline and Plugin delivery stalled do not reach rules with Run kind or experiment conditions.

## Plugin unreachable or deliveries stalled

| Symptom | Fix |
| --- | --- |
| `plugin_token_unavailable` | Put the plugin token in the API server's `.env` under the registered variable name, and restart the API |
| **接続を確認** (Check connection) fails | Check that the plugin is running and its URL is reachable from the API server. Check that the plugin's `MMT_PLUGIN_TOKEN` and the API server's value match |
| Operations alert Plugin delivery stalled | Check the last error in **イベントの送信状況** under **Plugins**, fix the plugin, then click **イベントを再送** (Resend events) |

## The worker does not take Jobs or shows as offline

Run on the worker host:

```sh
mado-tracking-worker status --worker-id gpu-host-1
mado-tracking-worker doctor --worker-id gpu-host-1
journalctl --user -u mado-tracking-worker@gpu-host-1 -f
```

- If `doctor` reports a token scope error, check that the Service Account token has `read`, `worker:execute`, and `artifacts:write`.
- If the token returns 401, check whether it expired or the Service Account is disabled. Replace the token with `mado-tracking-worker install --token-file`.
- Connection checks of a Compute target are done only by workers whose `MMT_WORKER_TARGET_IDS` includes that target.

See [Worker](/en/compute/worker) for details.

## A computer is missing from the targets, or Jobs cannot be created (`target_not_available`)

- The target list shows only the computers you can use. Check 自分が使えるか (Can you use it) under コンピュータ (Computers) in the global settings.
- You cannot use other people's Private computers, and neither can global administrators. Ask the owner to make it Public, or add your own computer.
- Automation rules, hooks, and Sweeps are checked with their owners. If you moved a rule to a Service Account, check that the computer's owner created that Service Account.
- If a queued Job failed with `submit_failed`, the computer may have become Private after the Job was created.
- Opening a site's job shell, keys, or own settings returns 403 `target_not_available` for the same reason: you cannot use that computer.

See [Computers and visibility](/en/compute/computers).

## Post-processing of a finished Run is missing

If post-processing after a Run ends (such as registering output models) fails, this line appears on the API's standard error. The Run's end and the GPU release are final. It is not retried automatically, so check whether the Run's registration or automation records are missing.

```json
{"event":"run_completion_handler_failed","handler":"<handler name>","runId":"<Run ID>","message":"<error>"}
```

## Artifacts on a storage backend return 503

Changing `MMT_STORAGE_SECRET_KEY` makes the secrets of S3 backends added on the screen undecryptable, and `storage_backend_unavailable` appears in the log at startup. Enter each S3 backend's secret again in **全体管理** (Global administration) → **ストレージ** (Storage) ([Storage](/en/data/storage)).
