---
title: Permissions and roles
description: Global administrators, the Project roles Viewer, Editor, and Admin, Project visibility, and how direct and group grants combine into the effective role.
---

# Permissions and roles

Permissions have two levels: whether a user is a global administrator, and the role in each Project.

## Global settings and global administration

The global settings are the pages that do not belong to a Project (`/settings/<section>`). Anyone can open them from **全体設定** (Global settings) in the user menu at the top right. The sidebar items fall into two groups.

| Group | Items | Who sees it |
| --- | --- | --- |
| 全体設定 (Global settings) | アカウント (Account), コンピュータ (Computers) | Everyone |
| 全体管理 (Global administration) | プロジェクト (Projects), ユーザー (Users), ストレージ (Storage), ランチャー (Launchers), 監査ログ (Audit log) | Global administrators only |

These groups appear only in the sidebar of the global settings pages, not on Project pages. People who are not global administrators do not see 全体管理, and opening one of its URLs directly takes them to **アカウント**. Old URLs starting with `/admin` or `/account` move to the new ones (`/settings/projects`, `/settings/account`, and so on).

![A regular user's user menu: Account, Change password, and Global settings](/images/admin-user-menu.png)

The user menu at the top right has **アカウント** (Account), **パスワードの変更** (Change password, local accounts only), and **全体設定** (Global settings) ([Authentication modes and local accounts](/en/admin/auth#check-your-account)).

## Global administrators

Global administrators manage application-wide settings. Most of their pages open from the 全体管理 (Global administration) group in the sidebar of the pages opened from **全体設定** (Global settings) in the user menu.

- Listing every Project, and restoring or permanently deleting archived Projects (**全体管理** → **プロジェクト** (Projects); see [Create and manage Projects](/en/admin/projects))
- Creating, disabling, and resetting passwords of users (**全体管理** → **ユーザー** (Users))
- Adding storage backends and choosing the default backend (**全体管理** → **ストレージ** (Storage); see [Storage](/en/data/storage))
- Registering launchers (**全体管理** → **ランチャー** (Launchers))
- The global audit log (**全体管理** → **監査ログ** (Audit log))
- Adding SSH and Local computers, and changing the settings and visibility of every computer (コンピュータ in the global settings; see [Computers and visibility](/en/compute/computers)). They still cannot run Jobs on other people's Private computers. Researchers can add sites too
- Creating, changing, and testing notification channels ([Notifications and operations alerts](/en/admin/notifications))
- Registering and changing plugins ([Plugins and Mado integration](/en/admin/plugins))

Whether an SSO user is a global administrator is decided by Authentik groups ([Authentik (SSO)](/en/admin/sso)). For local accounts, use **管理者にする** (Make administrator) and **管理者を外す** (Remove administrator) in **全体管理** → **ユーザー**.

A global administrator signed in from a browser can operate any Project as an Admin, including Private Projects they are not a member of. With an API token, even a global administrator needs a role in the Project.

## Project roles

| Role | Can do |
| --- | --- |
| Viewer | View experiments, Runs, models, datasets, and Artifacts |
| Editor | Everything Viewer can, plus recording experiments, registering models and datasets, running Jobs, and changing aliases (a protected alias only with a passing promotion check) |
| Admin | Everything Editor can, plus Project settings (description, visibility, storage), members and group grants, Service Accounts, the Project token list, notification rules, transferring automation owners, deleting Artifacts, using plugins, the Project audit log, and archiving the Project |

Any user who is not disabled can create a Project: click **＋ プロジェクトを作成** (Create project) at the bottom of the Project switcher. The creator becomes an Admin of the new Project. See [Create and manage Projects](/en/admin/projects) for the steps.

## Project visibility

A Project is Public or Private. New Projects are Public by default.

| Visibility | Who can see it |
| --- | --- |
| Public | Everyone who can sign in. They work as Editors without being added as members |
| Private | Members only (direct grants and group grants) |

- Even in a Public Project, Admin is granted only to members.
- Public access is given only to the accounts of active people, not to Service Accounts or launchers.
- A Project Admin changes the visibility in the プロジェクト (Project) section of **プロジェクト設定** (Project settings). Projects that existed before visibility was introduced become Private on upgrade.

See [Create and manage Projects](/en/admin/projects#visibility) for details.

## Computer visibility

Computers that run Jobs also have Public and Private, separately from Projects. Jobs from any Project can run on a Public computer. On a Private computer, only Jobs of the owner (the person who added it) and of the Service Accounts the owner created run, whatever their Project role. Global administrators are no exception. See [Computers and visibility](/en/compute/computers#visibility).

## Direct grants and group grants

There are two ways to grant a Project role. A Project Admin sets both in **プロジェクト設定** (Project settings).

![The Members and Authentik group sections of a Project](/images/admin-permissions.png)

| Method | Granted to | Where |
| --- | --- | --- |
| Direct grant | One user | **メンバーを追加** (Add member) under **Members** |
| Group grant | An Authentik group | **groupを追加** (Add group) under **Authentik group** |

The effective role is the strongest of the direct grant and the grants of the groups the user belongs to. In a Public Project, the Editor role everyone who can sign in gets is included as well.

| Direct grant | Group grant | Effective role |
| --- | --- | --- |
| Viewer | Editor | Editor |
| Admin | Viewer | Admin |
| None | Editor | Editor |
| Editor | None | Editor |

In the **Members** list, the effective role and source columns (for example "直接付与: Editor" for a direct grant, or "group mmt-proj-asr-editors") show where a role comes from. The list shows only people with a direct or group grant. People who only use the Project through Public access are not listed, and the effective role column does not include the Public Editor role.

The effective role is the same on the screen, in the native API, in the MLflow-compatible API, for API tokens, and for Job tokens.

### Add a member

1. Click **メンバーを追加** (Add member) under **Members** in **プロジェクト設定**.
2. Type the start of a name, email, or username and pick the user. SSO users appear only after their first login.
3. Choose a role and save.

The member is added when the user appears in the list.

### Remove a direct grant

Click **外す** (Remove) on the row. Roles granted through groups remain. If only a group role remains, the confirmation says so.

## A Project always needs an Admin

A Project needs at least one direct Admin grant or Admin group grant. Removing or lowering the last one returns 409, and the screen says the change would leave the Project without an Admin. Grant Admin to another member or group first.

An Admin group grant counts even if nobody in that group has signed in yet. Service Accounts with the Admin role do not count.

## Permissions of API tokens

For requests with an API token, both the token's scopes and the owner's current effective role are checked. If either is insufficient, the request returns 403.

- Missing scope: 403 `insufficient_scope`
- Insufficient role, or a Project other than the token's: 403 `project_forbidden`

When the owner is removed from the Project, the owner's tokens stop working in that Project from the next request. See [API tokens and Service Accounts](/en/admin/tokens) for the scopes and roles.

## Records of permission changes

Changes to direct grants, group grants, and visibility are recorded in the audit log ([Audit log](/en/admin/audit)).

| Operation | Audit action |
| --- | --- |
| Change the visibility | `project.update` |
| Add or change a direct grant | `project.member.set` |
| Remove a direct grant | `project.member.delete` |
| Add or change a group grant | `project.group_binding.set` |
| Remove a group grant | `project.group_binding.delete` |
