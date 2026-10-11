---
title: Security
description: What mado ML Tracking protects, where credentials and secrets live, and what operators need to do.
---

# Security

## Authentication and sessions

- Browser sessions use HttpOnly, SameSite=Lax cookies, with Secure when `MMT_PUBLIC_URL` is HTTPS. A session ends after 8 hours without activity or 12 hours after login, whichever comes first ([Authentication and local accounts](/en/admin/auth)).
- Changing requests made with a cookie are checked for Origin. Only exact matches of `MMT_WEB_ORIGIN` and `MMT_PUBLIC_URL` are allowed. With `MMT_ALLOW_PRIVATE_ORIGINS=true`, private IPs, loopback, link-local, CGNAT, IPv6 ULA, and localhost are allowed too. Requests without an Origin or with an unknown one get 403 `invalid_origin`.
- Local account passwords are stored as Argon2id hashes, and login attempts are rate limited.
- SSO verifies state, nonce, PKCE, and the ID token's signature, issuer, and audience. The callback is accepted only from the browser that started the login.
- SSO sessions recheck groups with Authentik every 60 seconds and stop users removed from groups. When Authentik is unreachable, requests are not allowed with unchecked permissions (503 `oidc_unavailable`).
- In production (`NODE_ENV=production`), HTTPS URLs are mandatory, and the development login, sample data, the local executor, and HTTP issuers are disabled.

## API tokens

- Token values are not stored. Only a SHA-256 hash and the first 12 characters (to tell tokens apart) are kept. The value is shown once, at issue time.
- Every token has an expiry (365 days at most). Scopes and the owner's current Project role are checked on every request.
- SSO users' tokens stop 7 days after the last browser login, so that removal from a group is noticed.
- Running code receives a Job token valid only during the Job, never the worker's own token. It can write only to the target Run and its outputs ([API tokens and Service Accounts](/en/admin/tokens)).
- Basic authentication on the MLflow-compatible API accepts only an API token in the password. Local account passwords are not accepted.

## Where secrets live

| Secret | Location | Database and screens |
| --- | --- | --- |
| Database URL, SSO client secret, SMTP URL | The API server's `.env` | Neither stored nor shown |
| Notification webhook URLs and signing keys | The API server's `.env` (`MMT_NOTIFICATION_*`) | Only the variable names are stored |
| Tokens for connecting to plugins | The API server's `.env` | Only the variable names are stored |
| Secrets of S3 backends added on the screen | Database (encrypted with `MMT_STORAGE_SECRET_KEY`) | Never returned to screens |
| Authentik tokens of sessions | Database (encrypted with `MMT_SESSION_ENCRYPTION_KEY`) | Never returned to screens |
| Worker tokens | The environment file on the worker host (mode 600) | Hash only |
| SSH private keys and known_hosts | The worker host | Only the paths are registered |

Changing `MMT_STORAGE_SECRET_KEY` makes stored S3 secrets undecryptable, and Artifacts on those backends return 503. After changing the key, enter each S3 backend's secret again. Changing `MMT_SESSION_ENCRYPTION_KEY` makes SSO users sign in again at the next recheck.

The API server never connects to worker hosts over SSH. Workers are installed and upgraded with the CLI on the worker host.

## Audit log

Logins, permissions, tokens, users, storage, notification channels, and other operations are recorded indefinitely and cannot be deleted or altered. Passwords, tokens, and secret values are not recorded ([Audit log](/en/admin/audit)).

## Artifacts and running code

- Artifacts are stored under server-generated IDs. Users' file names are used only for display.
- HTML, SVG, XML, JavaScript, and similar Artifacts are returned as downloads, not opened in the browser.
- Plugin UI components and arbitrary JavaScript are never run in the browser.
- Workers always verify SSH host keys (`StrictHostKeyChecking=yes`). Unknown or changed host keys are refused.
- Running code receives only the CodeVersion's settings and the SDK connection. Unrelated secrets of the worker are not passed.

## What is not protected

- Registered code runs on Compute targets with the permissions of the target account. Editors can run Jobs, so making someone an Editor of a Project that shares a Compute target lets them run code on that host.
- GPU reservations are exclusive only among this application's Jobs. Other SSH shells or schedulers using the same GPUs are not prevented.
- A Project Viewer can read every Run, model, dataset, and Artifact in the Project. There are no read restrictions finer than a Project.

## What operators need to do

- Serve production over HTTPS and do not expose the API and database ports. The bundled `compose.yml` publishes only the web port.
- Keep `.env` at `chmod 600`, and never paste its values into repositories, tickets, or chats.
- Back up the database and the Artifact storage at the same point in time. Restoring only the database does not bring back weights or audio.
- Use Service Account tokens, not personal tokens, for workers, automation, and CI, and replace them before they expire.
- When someone leaves or changes teams, disable the user and remove them from the Authentik groups.
- On shared GPU machines, give Compute targets GPUs and working directories dedicated to this application.
