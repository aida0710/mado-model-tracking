---
title: Create and manage Projects
description: Switching and creating Projects, visibility (Public and Private), archiving and restoring, and deleting permanently.
---

# Create and manage Projects

A Project groups experiments, models, datasets, and Artifacts. Member permissions and the Artifact storage are also set per Project.

| Operation | Who | Where |
| --- | --- | --- |
| Create | Every user who is not disabled | **＋ プロジェクトを作成** (Create project) in the Project switcher. Global administrators can also use **全体管理** (Global administration) → **プロジェクト** (Projects) |
| Change the description, visibility, or storage | Project Admins | **プロジェクト** (Project) in **プロジェクト設定** (Project settings) |
| Archive | Project Admins, global administrators | The bottom of **プロジェクト設定**, or **全体管理** → **プロジェクト** |
| Restore, delete permanently | Global administrators | **全体管理** → **プロジェクト** |

## Switch Projects

Click the name of the current Project under プロジェクト (Project) at the top of the sidebar. On narrow screens it is below the top bar.

![The Project switcher listing names, Private, and your role, with "Create project" at the bottom](/images/admin-project-switcher.png)

The list shows the Projects you can see: Public Projects and the Private Projects you are a member of. Each row shows the name and your role; Private Projects have a lock icon. The current Project is marked.

- Choose with ↑ and ↓ and open with Enter. Esc closes the list.
- With eight or more Projects, a filter box appears at the top.
- **＋ プロジェクトを作成** (Create project) at the bottom creates a new Project.

## Create a Project

1. Open the Project switcher and click **＋ プロジェクトを作成** (Create project) at the bottom. Global administrators can also use **プロジェクトを作成** under **全体管理** → **プロジェクト**.
2. Enter the following values.
3. Click **作成** (Create).

| Field | Value |
| --- | --- |
| 名前 (Name) | Required. For example, `音声認識の実験` |
| 説明（任意） (Description, optional) | The purpose of the Project, for example |
| 公開範囲 (Visibility) | Public (default) or Private. See the next section |
| メンバー（任意） (Members, optional) | Shown only when Private is selected. Add members as described below |
| Artifact保存先 (Artifact storage) | The default storage is preselected ([Storage settings](/en/data/storage)) |

The new Project opens after it is created. The creator becomes an Admin of the Project.

![The create dialog with Private selected and two members added](/images/admin-project-create.png)

For a Private Project that others will use, add them under メンバー（任意） (Members, optional).

1. In **メンバーを追加** (Add member), type the start of a name, email, or username and pick the user. SSO users appear only after their first login.
2. Choose a role on each row. The default is Editor.
3. To remove someone, click **外す** (Remove) on the row.

Only the accounts of active people are suggested; you, Service Accounts, and disabled users are not. You can also add members later under **Members** in **プロジェクト設定** ([Permissions and roles](/en/admin/permissions)).

If there is no Project you can see, the プロジェクト (Projects) page appears after login. Create the first Project with **プロジェクトを作成** (Create project).

## Visibility (Public and Private) {#visibility}

| Visibility | Who can see it | Role |
| --- | --- | --- |
| Public | Everyone who can sign in | Editor, without being added as a member |
| Private | Members only (direct grants and group grants) | The role granted to the member |

- Even in a Public Project, Admin is granted only to members (direct grants and group grants).
- In a Public Project, everyone who can sign in is Editor or higher. A member granted Viewer still works as an Editor. If some people should only view, make the Project Private.
- Public access is given only to the accounts of active people, not to Service Accounts or launchers.
- People who only use a Project through Public access are not listed under **Members**, and are not counted in メンバー数 (Members) under **全体管理** → **プロジェクト**.

A Project Admin changes the visibility in the プロジェクト (Project) section of **プロジェクト設定**: choose 公開範囲 (Visibility) and click **保存** (Save).

Projects that existed before visibility was introduced become Private on upgrade. As before, only members can see them.

### Global administrators

A global administrator signed in from a browser is treated as an Admin of every Project, including Private Projects they are not a member of. The Project switcher lists every Project that is not archived.

With an API token, even a global administrator needs a role in the Project ([Permissions and roles](/en/admin/permissions)).

## Archive

Archiving removes a Project you no longer use from the lists. The data stays, and a global administrator can restore it later.

1. At the bottom of **プロジェクト設定**, click **アーカイブ** (Archive) under プロジェクトをアーカイブ (Archive project). Global administrators can also use **アーカイブ** on the row in **全体管理** → **プロジェクト**.
2. Click **アーカイブ** in the confirmation dialog.

An archived Project disappears from the Project switcher and nobody can open it. Runs, models, Artifacts, and other data remain.

- A Project with queued or running Jobs cannot be archived (409 `project_has_active_jobs`). Wait for the Jobs in **Jobs** to finish, or stop them, and archive again.
- While the Project is archived, API tokens limited to it (including those of workers and Service Accounts) return 401. A Run being recorded by the SDK can no longer record.
- Sweeps, hooks, automatic inference and evaluation, and automatic promotion stop too.

## Restore

A global administrator restores a Project.

![Projects under global administration, including archived ones](/images/admin-projects.png)

1. Open **プロジェクト** (Projects) under 全体管理 (Global administration) in the sidebar.
2. Select アーカイブ済みも表示 (Show archived). Archived Projects appear as アーカイブ済み (Archived).
3. Click **元に戻す** (Restore) on the row, then **元に戻す** in the confirmation dialog.

Members and data are the same as before archiving. API tokens limited to the Project work again.

## Delete permanently

This deletes an archived Project together with its data. It cannot be undone. Only global administrators can delete, and only archived Projects.

1. In **全体管理** → **プロジェクト**, select アーカイブ済みも表示 (Show archived).
2. Click **完全に削除** (Delete permanently) on the row of the Project.
3. Type the Project name in 確認のため、プロジェクト名を入力してください (Type the project name to confirm) and click **完全に削除**.

After deletion:

- Everything in the Project is deleted: Runs, models, datasets, Artifacts, Jobs, reports, members and group grants, and so on.
- Files in the Artifact storage are removed by the garbage collector after the grace period (`MMT_ARTIFACT_DELETE_GRACE_DAYS`, 7 days by default). Until then, the files remain in the storage.
- API tokens limited to the Project are revoked, and its Service Accounts are disabled.
- The audit log remains. Read it in **全体管理** → **監査ログ** (Audit log).
- Things outside mado ML Tracking, such as dataset caches on external computers, are not deleted.

A Project that is not archived cannot be deleted (409 `project_not_archived`).

## Audit log

Creating and managing Projects is recorded in the audit log ([Audit log](/en/admin/audit)).

| Operation | Audit action |
| --- | --- |
| Create | `project.create`. Members added at creation are recorded as `project.member.set` |
| Change the description, visibility, or storage | `project.update` |
| Archive | `project.archive` |
| Restore | `project.restore` |
| Delete permanently | `project.purge` |

## API

| Operation | API | Required permission |
| --- | --- | --- |
| Create | `POST /api/projects` (`name`, `description`, `visibility`, `artifactBackend`, `members`) | A signed-in user. API tokens need the `admin` scope and must not be limited to a Project |
| Change | `PATCH /api/projects/<Project ID>` (`description`, `visibility`, `artifactBackend`) | Project Admin |
| Archive | `POST /api/projects/<Project ID>/archive` | Project Admin |
| List, including archived | `GET /api/admin/projects?includeArchived=true` | Global administrator |
| Restore | `POST /api/admin/projects/<Project ID>/restore` | Global administrator |
| Delete permanently | `DELETE /api/admin/projects/<Project ID>` | Global administrator |
| Search users to add as members | `GET /api/users?query=<start of a name>` | Anyone who can create Projects. A token limited to a Project needs Admin in that Project and the `admin` scope |

`visibility` is `public` or `private`, and `members` is an array of `{"userId": "<user ID>", "role": "editor"}`. Listing the same user twice returns 400, an unknown user 404, and a Service Account or disabled user 400; in each case no Project is created. See [Native API](/en/reference/api) for details.
