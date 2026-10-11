---
title: Shared reports
description: Share pages that combine text with metric charts, analysis, Run tables, and media in a Project, and follow changes in the version history.
---

# Shared reports

![A shared report](/images/data-reports.png)

A shared report is a page of Markdown text with embedded metric charts, media comparisons, and more. Use it to summarize experiment results and share them with Project members. Every save creates a new version, and all earlier versions stay in the history.

For each embedded block you choose whether it shows the latest data every time or data fixed at the time of saving.

The web UI is in Japanese. This page shows UI labels in Japanese followed by an English translation.

## When to use it

- You want to record a comparison of two model versions with their training curves and generated audio side by side.
- You want to share Sweep results with parallel coordinates and parameter importance.
- You want charts that do not change as experiments continue, fixed at a point in time.
- You want to see who changed what and when in the version history.

## Create a report

1. Open **Reports** in the sidebar and click **レポートを作成** (Create report).
2. Enter a title and click **作成** (Create). The editor opens.
3. Add blocks with **文章を追加** (Add text) or **図や表を埋め込む** (Embed a chart or table).
4. Optionally describe the change in **変更の説明** (Change description).
5. Click **保存** (Save).

**レポートを作成** is shown to editors and above. Reorder blocks with **上へ移動** (Move up) and **下へ移動** (Move down), and remove them with **削除** (Delete). Text blocks use Markdown.

## What you can embed

| Type | Shows | Main settings |
| --- | --- | --- |
| 文章 (Text) | Markdown text | Up to 100,000 characters per block |
| メトリクスの図 (Metric chart) | Line chart of metrics | Chart settings (metrics, x-axis, smoothing, and so on) |
| 平行座標 (Parallel coordinates) | How parameters relate to a metric | Parameters for the axes, metric |
| パラメータの重要度 (Parameter importance) | Which parameters affect the result | Target metric |
| 散布図 (Scatter plot) | Relationship between two values | X axis, Y axis, color |
| Run一覧 (Run table) | A table of Runs | Columns, number of rows (up to 500) |
| メディアの比較 (Media comparison) | A grid of audio or images by Run and step | Media key, steps to compare (up to 20 Runs) |
| メディアの表 (Media table) | A table logged in a Run | Run, table |

### Choose the Runs

For every chart or table except the media table, set **対象のRun** (Runs) in one of these ways:

| Option | What it uses |
| --- | --- |
| 選んだRun (Selected Runs) | Runs you pick directly, up to 200 |
| 保存ビュー (Saved view) | Runs matching a saved view. Only saved views shared with the Project can be chosen |
| 検索式 (Search expression) | An MLflow search expression, for example `metrics.val_loss < 0.5` |
| Sweep | Trials of a Sweep |

### Latest data or fixed data

**表示するデータ** (Data to show) decides how a block is drawn.

| Option | Behavior |
| --- | --- |
| 最新データ (Latest data) | Drawn with the current data each time someone opens the report, using that viewer's permissions. Runs the viewer cannot see are not shown |
| 保存時に固定 (Fixed at save) | The data at the time of saving is stored with the version and used to draw the block. New Runs or later changes do not affect it |

Fixed blocks show the capture time followed by 時点で固定 (fixed as of), for example 2026-10-08 22:48 時点で固定. Blocks unchanged since the previous version keep the previous version's fixed data. To capture the latest data again, turn on **保存時に固定データを作り直す** (Recapture fixed data on save) in the editor and save.

Fixed media comparisons point to Artifacts. Artifacts never change, so the audio itself stays as it was when saved.

## Version history

The top of a report shows the current version number, who updated it, and when (for example 版 4・admin@localhostが2026/10/08 23:25に更新).

1. Click **版の履歴** (Version history). Each version shows who saved it, when, and the change description.
2. Click **表示** (View) on an earlier version to open it read-only. **最新の版を表示** (Show latest version) returns.
3. To go back to an earlier version, click **この版に戻す** (Restore this version) and confirm in the 版を戻す (Restore version) dialog.

Restoring creates a new version with that version's content. No version is removed from the history, and the fixed data of the restored version is reused as is.

### Concurrent edits

If someone saved a newer version first, your changes are not saved and a message explains why. Click **最新の版を読み込む** (Load the latest version), then edit again. Loading the latest version discards unsaved changes on screen.

## Sharing and permissions

Project members open reports from **Reports**. Sending the URL (`/projects/<Project ID>/reports/<Report ID>`) lets members of the same Project open the same report. While viewing the history, `?revision=<version number>` in the URL points to that version.

There are no public links for people outside the Project and no embedding in other sites.

| Action | Who can do it |
| --- | --- |
| View, read comments | Viewers and above |
| Create, edit, restore versions, comment | Editors and above |
| Archive, unarchive | The creator or a Project admin |

Reports cannot be deleted. Use **アーカイブ** (Archive) for reports you no longer need. Archived reports are hidden from the list (shown with **アーカイブ済みも表示**, Show archived) and can no longer be edited or commented on. Their content and history remain, and you can unarchive them later.

## Limits

- Up to 200 blocks per report
- Titles up to 300 characters
- Fixed data up to 5 MiB per block and 50 MiB per version by default (`MMT_REPORT_SNAPSHOT_MAX_BYTES`)
- Fixed metric charts up to 200 Runs; parallel coordinates, importance, and scatter plots up to 5,000 Runs

## Related pages

- [Metric charts](/en/tracking/charts)
- [Compare and analyze Runs](/en/tracking/compare)
- [Media logging](/en/tracking/media)
- [Sweeps](/en/tracking/sweeps)
