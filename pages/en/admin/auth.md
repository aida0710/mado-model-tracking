---
title: Authentication and local accounts
description: Choose the login method (local, oidc, or hybrid) and manage local accounts, the initial administrator, and passwords.
---

# Authentication and local accounts

The login method is set with the `AUTH_MODE` environment variable of the API server. You can use Authentik (SSO) only, local accounts only, or both. The layout is the same as Mado.

| `AUTH_MODE` | Login methods | Required settings | Good for |
| --- | --- | --- | --- |
| `local` | Local accounts | None (`OIDC_*` is ignored) | Environments without SSO, closed LANs |
| `oidc` | Authentik (SSO) only | `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_ALLOWED_GROUPS`, `MMT_SESSION_ENCRYPTION_KEY` | Production after the move to SSO |
| `hybrid` (default) | SSO and local accounts | Same as `oidc` | Introducing SSO while keeping a local administrator as an emergency login |
| `development` | Development login | None | Local development. Refused when `NODE_ENV=production` |

If a required setting is missing, the API prints only the names of the missing settings and does not start. Values are never logged. Login routes of a mode you did not choose return 404 (the SSO start and callback in `local`, the local login in `oidc`).

The Authentik side and group-based permissions are described in [Authentik (SSO)](/en/admin/sso).

## Login screen

The login screen shows only the methods enabled by `AUTH_MODE`.

- `oidc`: the SSO button only. Its label is `OIDC_LABEL` (default `Authentik`)
- `hybrid`: the SSO button, then the username and password fields for local accounts
- `local`: the username and password fields only

A session ends after `AUTH_SESSION_IDLE_SECONDS` without activity (default 28800 seconds, 8 hours) or `AUTH_SESSION_ABSOLUTE_SECONDS` after login (default 43200 seconds, 12 hours), whichever comes first. The API does not start if the idle limit is longer than the absolute limit.

## Create the initial administrator

In `local` and `hybrid`, create the first global administrator in a terminal on the API server. The username and password are typed in the terminal and never appear in command arguments or logs.

```sh
npm run bootstrap-admin -w @mmt/api
```

With Docker Compose, run it in the API container:

```sh
docker compose run --rm api npm run bootstrap-admin -w @mmt/api
```

| Prompt | What to enter |
| --- | --- |
| `Admin username:` | The administrator's username: lowercase letters, digits, `.`, `_`, and `-` (for example `admin`) |
| `New admin password:` | A password used once (12 to 1024 bytes). Input is hidden |
| `Confirm password:` | The same password again |

`Admin ready: admin (<user ID>); password change required` means the account is ready. When you sign in from a browser, the password change screen opens. Until the password is changed, other screens and API calls are refused (403 `password_change_required`).

If the username already exists, the command makes that user an active global administrator again, replaces the password, and ends the user's sessions. Use it to recover when an administrator forgets the password or all global administrators are locked out. Creation and reset are recorded in the audit log as `auth.bootstrap_admin`.

## Create a local account

A global administrator creates local accounts on the screen. You can create them in any `AUTH_MODE`, but they cannot sign in when the mode is `oidc`.

![The Users page under global administration](/images/admin-users.png)

1. Open **ユーザー** (Users) under 全体管理 (Global administration) in the sidebar (`/settings/users`). This group appears both in the sidebar of Project pages and on the pages opened from **全体設定** (Global settings) in the user menu at the top right.
2. Click **ローカルユーザーを作成** (Create local user).
3. Enter the following and save.

| Field | Value |
| --- | --- |
| Username | Lowercase letters, digits, `.`, `_`, `-`, up to 64 characters. Example: `tanaka` |
| Display name | The name shown on screens. Example: `Tanaka` |
| Email (optional) | Example: `tanaka@example.com` |
| Initial password | At least 12 characters. **生成** (Generate) creates a random value |
| Make global administrator | Select only for a global administrator |

The account is created when it appears in the list. Give the initial password to the user through a safe channel. The user must change it at the first login.

A new user can use Public Projects right away. To use a Private Project, add the user under **Members** in **プロジェクト設定** (Project settings) ([Permissions and roles](/en/admin/permissions)).

## Passwords

Local account passwords are stored as Argon2id hashes. A new password must be 12 to 1024 bytes and differ from the current one.

- Change your own: open **パスワードの変更** (Change password) from the user menu (your avatar) at the top right (`/settings/account/password`). You can also change it under パスワード (Password) on **アカウント** (Account) in the global settings. Changing it ends your logins in other browsers and machines.
- Forgotten password: a global administrator clicks **パスワード再設定** (Reset password) on the user's row in **全体管理** → **ユーザー**. A temporary password is shown once; give it to the user through a safe channel. The user's sessions end and the next login asks for a new password.
- SSO-only users have no password in this application. Their passwords are managed in Authentik.

Login and current-password checks are rate limited. Over the limit, the screen says the attempt limit was reached and the API returns 429 with `Retry-After`.

| Target | Limit |
| --- | --- |
| Logins from the same source address | 30 per minute |
| Failed logins for the same username | 10 per 15 minutes |
| Current-password checks when changing the password | 10 per 15 minutes per user |

The counters live in the API process memory and reset when the API restarts. An unknown username, a wrong password, and a disabled user all get the same "username or password is incorrect" message.

## Disable and re-enable users

When someone leaves or changes teams, a global administrator uses **全体管理** → **ユーザー**.

1. Click **無効化** (Disable) on the row and confirm. The user's sessions end immediately, and the user's API tokens (including the MLflow-compatible API) return 401 from the next request.
2. For SSO users, also remove the user from the Authentik groups. If you re-enable the user without doing so, the next login restores the global role derived from the groups.
3. To restore the user, click **有効化** (Enable) on the same row. API tokens work again, but ended sessions do not come back; the user signs in again.

Users cannot be deleted, so that the creators of Runs and model versions stay on record. The last active global administrator cannot be disabled or demoted (409 `last_global_admin`). Prepare another global administrator first.

For SSO users, Authentik is the source of truth for the global administrator flag and the display name, so they cannot be changed on the screen. The administrator column shows that the Authentik group is authoritative.

## Move to SSO

To move an environment that used local accounts to SSO, go through `hybrid`.

1. Put `AUTH_MODE=hybrid` and the [Authentik settings](/en/admin/sso) in `.env`, run `npm run db:migrate`, and restart the API.
2. Create a local administrator with `bootstrap-admin` and change its password.
3. Have an administrator and regular members sign in with SSO, and check the global administrator flag and Project permissions.
4. When everything is correct, change to `AUTH_MODE=oidc` and restart. Local account logins return 404.

If Authentik stops and nobody can sign in, change back to `AUTH_MODE=hybrid` and restart; the local administrator can sign in again.

## Check your account {#check-your-account}

Open **アカウント** (Account) from the user menu (your avatar) at the top right (`/settings/account`) to see your display name, email, login method, whether you are a global administrator, your groups (SSO users only, with the last sync time), and your API tokens. Local accounts can also change their password here. You can also open it from **アカウント** in the global settings sidebar.

![The account screen](/images/admin-account.png)
