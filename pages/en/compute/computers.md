---
title: Computers and visibility
description: Add the computers that run Jobs (SSH, Local, sites) under コンピュータ in the global settings, and decide who can use each one with its visibility (Public or Private). Owners, hooks and automation, and how this relates to a Project's Compute page.
---

# Computers and visibility

![コンピュータ (Computers) in the global settings: every computer with its kind, owner, visibility, state, and whether you can use it](/images/compute-computers.png)

A computer is a place where Jobs run. There are three kinds.

| Kind | What it is | How to set it up |
| --- | --- | --- |
| SSH | A GPU machine the worker reaches over SSH | [Compute targets](/en/compute/targets) |
| Local | The worker's own host. Available only in development mode | [Compute targets](/en/compute/targets) |
| Site | A supercomputer, a lab GPU server, or your own PC. Jobs are submitted by a launcher or by `mado-tracking submit` | [External computers (sites)](/en/compute/sites) |

Computers do not belong to a Project. You add them under **コンピュータ** (Computers) in the global settings, and each computer's visibility (Public or Private) decides whose Jobs can run on it.

## When to use this

- You want to add your PC or a lab GPU server and use it only for your own experiments.
- You want a shared GPU server to be usable from every Project.
- You want to see what computers other people have added and whether you can use them now.

## Open コンピュータ in the global settings

Click **全体設定** (Global settings) in the user menu at the top right, then open **コンピュータ** (Computers) under 全体設定 in the sidebar (`/settings/computers`). Anyone can open the global settings, not only global administrators. You can also get there from **全体設定の「コンピュータ」を開く** (Open Computers in the global settings) on a Project's **Compute** page.

The list shows every computer, including other people's Private ones.

| Column | Content |
| --- | --- |
| 名前 (Name) | For a computer you can use or manage, click the name to open its details below the list |
| 種類 (Kind) | SSH, Local, or Site, with the CPU architecture and, for a site, automatic or manual submission and array support |
| 所有者 (Owner) | The person who added the computer. 自分 (You) for your own, 全体 (Global) for one without an owner |
| 公開範囲 (Visibility) | Public or Private. Private has a lock icon |
| 状態 (State) | Enabled or disabled. For an automatic site, also the launcher's state, such as no response or revoked |
| 自分が使えるか (Can you use it) | Whether your Jobs run on the computer |
| 操作 (Actions) | Only owners and global administrators see **コンピュータを編集** (Edit the computer) and **無効にする** (Disable), plus **接続を確認** (Check the connection) for SSH and Local |

For a computer you cannot use (someone else's Private computer), only the name, kind, owner, visibility, and state are shown. The destination, accounts, paths, and job shell are not.

## Add a computer

Anyone can add their own computers. Whoever adds a computer becomes its owner.

| Who | Can add |
| --- | --- |
| Global administrators | SSH and Site, plus Local in development mode |
| Other users (researchers) | Site only |

1. Under **コンピュータ** in the global settings, click **コンピュータを追加** (Add a computer).
2. Enter a name and choose **公開範囲** (Visibility). The default is Private. Global administrators also choose the kind in **Executor**.
3. Fill in the settings for the kind and click **保存** (Save). For SSH and Local, see [Compute targets](/en/compute/targets#register-a-target); for sites, see [External computers (sites)](/en/compute/sites#add-a-computer).

After saving, the computer's details open below the list.

## Visibility {#visibility}

| Visibility | Who can run Jobs |
| --- | --- |
| Public | Everyone. Jobs from any Project can run |
| Private | The owner, and the Service Accounts the owner created |

On a Private computer, the check uses the person a Job runs as.

| How the Job starts | Who is checked |
| --- | --- |
| Creating a Job, running a Task, or rerunning, from the screen, the Python SDK, or the API | The creator of the Run (for a token, the token's owner) |
| Hook | The hook's owner |
| Automation rule | The rule's owner (the Service Account, if you [moved ownership to one](/en/models/automation#move-rule-ownership)) |
| Sweep | The person who created the Sweep |

- "Service Accounts the owner created" are the Service Accounts that the owner created as a Project Admin. A Service Account created by someone else cannot use the owner's Private computers.
- Service Accounts cannot have their own settings (自分の設定), so they cannot use sites that submit with each person's own account ([External computers (sites)](/en/compute/sites#keys-and-connection-checks)).
- Even a global administrator cannot run Jobs on a Private computer they do not own. They can still change its settings, disable it, or make it Public.

Creating a Job on a computer you cannot use returns 422 `target_not_available`. Tasks, automation rules, hooks, and Sweeps run the same check when they are saved.

### Change the visibility

The owner or a global administrator chooses another **公開範囲** in **コンピュータを編集** in the list and saves. The change is recorded in the audit log (`compute_target.update`).

- A computer without an owner stays Public and cannot be made Private (422 `target_owner_missing`).
- When a computer becomes Private after Jobs were created, the queued Jobs of people who can no longer use it fail when they are submitted (`submit_failed`). Running Jobs are not stopped.

### Computers from before visibility existed

Computers that existed before visibility was introduced became:

- Public, if they have no owner (those added by global administrators)
- Private, if they have an owner (sites added by researchers)

Sharing with Projects no longer exists. To let others use a computer you used to share, its owner makes it Public.

## A Project's Compute page

![A Project's Compute page: the computers you can use, and the workers](/images/compute-targets.png)

A Project's **Compute** page shows the computers you can use (read only) and the state of the workers connected to the Project (**Workers**). To add or configure computers, use **全体設定の「コンピュータ」を開く** at the top right to go to the global settings.

The target list on the Job screens also shows only the computers you can use.

## Before you use someone else's computer

Using a Public computer means trusting its owner. The owner and global administrators decide the job shell and where the runner reports, and on the computer they can read the Job's spec directory (including the Job token). A Job token can write only to that Job's Run, but it can read the Project's data.

On a site that runs as your own account, the job shell chosen by the owner runs as you. See [External computers (sites)](/en/compute/sites#before-you-use-someone-elses-computer).

## Permissions

| Operation | Who |
| --- | --- |
| Open コンピュータ in the global settings and see every computer's name, kind, owner, visibility, and state | Anyone signed in |
| Add a site | Anyone signed in |
| Add SSH or Local computers | Global administrators |
| Change settings and visibility, enable or disable, check the connection, save job shells, the shared account's key | The owner or a global administrator |
| Run Jobs | Public: everyone. Private: the owner and the Service Accounts the owner created |

## Use the API

| Operation | API | Permission |
| --- | --- | --- |
| List every computer | `GET /api/targets/overview` | `read`. In each row, `usable` says whether your Jobs run there and `canManage` whether you manage it |
| Details of the computers you can use or manage | `GET /api/targets` (`?projectId=<Project ID>` returns only the ones you can use) | `read` |
| Add | `POST /api/targets` (`visibility` is `public` or `private`; `private` if omitted) | Anyone signed in from a browser (sites only; API tokens get 403 `session_required`). Global administrators can also add SSH and Local, and can use a token with the `admin` scope |
| Change settings and visibility | `PATCH /api/targets/<ID>` (`visibility` and other fields) | The owner (signed in from a browser) or a global administrator (a token with the `admin` scope also works). Others get 403 `target_owner_required` |

A researcher adding an SSH or Local computer gets 403 `target_admin_required`, and opening the job shell, keys, or own settings of a site you cannot use returns 403 `target_not_available`. See [API](/en/reference/api) for details.
