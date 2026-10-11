---
title: Artifacts
description: Where Artifacts for Runs and datasets are stored, how to browse and preview them, and how deletion and cleanup work.
---

# Artifacts

![Artifacts tab of a Run with an audio file open](/images/data-artifacts-run.png)

An Artifact is a file saved in a Project. Model weights, generated audio, evaluation results in jsonl, and dataset contents are all saved as Artifacts.

Artifacts are stored on the storage chosen for the Project (a file system or S3-compatible storage). The SDK and the worker read and write through the API, so you do not need to hand out storage credentials. See [Storage settings](/en/data/storage).

The web UI is in Japanese. This page shows UI labels in Japanese followed by an English translation.

## When to use it

- You want to keep model weights and checkpoints linked to the Run that produced them.
- You want to listen to generated audio while looking at its waveform in the browser.
- You want to find audio anywhere in a Project by path or type.
- You want to delete large files you no longer need to free space.

## Paths and versions

Artifacts are organized by path within a Run, such as `data/vowel-a.wav` or `checkpoints/step-1000/model.pt`. Saving to the same path in the same Run stores a new Artifact and makes the path show the new one. The earlier file is kept as a previous version (以前の版) and is not overwritten.

Some Artifacts do not belong to a Run: files of dataset versions created from a folder, and files uploaded from the **Models** or **Code** pages.

The SHA-256 and size of each file are recorded when it is saved. One Artifact can be up to 200 GiB by default (change it with `MMT_ARTIFACT_MAX_BYTES`).

## Browse a Run's Artifacts

Open the **Artifacts** tab of a Run. The file list is on the left and the preview of the selected file is on the right.

- Use the breadcrumb starting at ルート (Root) to move between folders.
- Folder rows show the number of files and total size, such as 6件 · 125.6 KiB.
- Folders come first, and numbers in names are compared as numbers (`step-9` comes before `step-19`).
- Files load 200 at a time. Click **続きを読み込む** (Load more) for the rest.
- Click the download icon on a row to download the file.

The open folder is kept in the URL, so reloading or going back returns to the same folder.

Open **詳細** (Details) under the preview to see the Artifact ID, SHA-256, storage name, and previous versions of the same path (up to 100). Select a previous version to preview it, and click **最新の版に戻る** (Back to latest version) to return.

Users who can edit see **Artifactをアップロード** (Upload Artifact). See [Large file uploads](/en/data/uploads).

## Search the whole Project

![Artifacts page of a Project](/images/data-artifacts-browser.png)

Open **Artifacts** in the sidebar to search every Artifact in the Project.

| Filter | Values |
| --- | --- |
| 検索 (Search) | Text contained in the saved path (up to 200 characters) |
| 種類 (Type) | All, audio, image, video, text, other files |
| Run | All Runs, or one of the recent Runs (up to 200) |
| モデル (Model) | All models, or one model. After choosing a model you can also filter by モデル版 (model version) |
| 以前の版も表示 (Show previous versions) | Include old versions that were replaced by newer files |

Results show the saved path, Run, type, size, and creation time, 100 at a time. Artifacts without a Run show Runなし (no Run). Filters are kept in the URL, so sharing the URL opens the same results.

## Preview formats

| Kind | Formats | Display |
| --- | --- | --- |
| Text | text/plain, CSV, TSV, JSON, JSON Lines | Up to 1 MiB |
| Evaluation samples | jsonl, CSV | Up to 16 MiB as a table, 50 rows per page |
| Image | PNG, JPEG, WebP, AVIF, GIF | Shown as is |
| Audio | WAV, FLAC, MP3, Ogg, Opus, M4A (AAC), WebM | Waveform and spectrogram in the [audio viewer](/en/data/audio) |
| Video | MP4, WebM, QuickTime | Played in the browser player |

Other formats and files over the limits show この形式はダウンロードして確認してください。(Download this file to view it.) HTML, SVG, and XML files are never previewed and are served as downloads.

When an upload has no MIME type, it is inferred from the extension (wav, flac, mp3, ogg, opus, m4a, aac, webm, mp4, mov, png, jpg, webp, avif, gif, csv, tsv, jsonl, txt, npy, parquet).

Evaluation results are easiest to read as jsonl with `audio`, `reference`, `prediction`, and `score` on each line.

## Compare across Runs

The **Artifacts** tab of the Compare page shows the same path from several Runs side by side. Audio has **同じ位置から再生** (Play from the same position), so you can switch Runs and keep listening from the same point. To compare audio and images per step, see [Media logging](/en/tracking/media).

## Delete and clean up

Only Project admins can delete Artifacts.

1. In the Run's **Artifacts** tab, open the file to delete.
2. Choose **削除** (Delete) from the **⋯** (file actions) menu at the top right of the preview.
3. Click **削除** (Delete) in the Artifactを削除 (Delete Artifact) dialog.

A deleted Artifact disappears from lists, search, and downloads immediately. If the same path has a previous version, that version is shown instead. There is no restore in the UI.

The file itself is not removed from storage right away. After a grace period (7 days by default, `MMT_ARTIFACT_DELETE_GRACE_DAYS`), the API removes it from storage during a cleanup that runs every 10 minutes. If you delete something by mistake, contact an administrator within the grace period; the file can still be copied out of storage.

Artifacts referenced by the following cannot be deleted. Remove the reference first.

- Weights of a registered model version (including files of models registered through MLflow)
- Code versions on the Code page (saved zip or tar archives, Singularity or Apptainer images)
- Files of a dataset version
- Checkpoints that are retained or were used to resume

Old versions are never deleted automatically.

MLflow SDK `delete_artifacts` follows the same rules. Through the API, call `DELETE /api/projects/<Project ID>/artifacts/<Artifact ID>`.

## Check usage

Artifactの使用量 (Artifact usage) at the top of **プロジェクト設定** (Project settings) shows usage per storage.

| Column | Meaning |
| --- | --- |
| 保存先 (Storage) | Storage name |
| 件数, 容量 (Count, Size) | Number and total size of Artifacts that are not deleted, including previous versions |
| 削除待ち (Pending deletion) | Deleted Artifacts whose files have not been removed yet |
| 参照されていない古い版 (Unreferenced old versions) | Versions replaced by a newer one and not referenced by model versions, dataset versions, and so on. Candidates for deletion |

## Related pages

- [Large file uploads](/en/data/uploads)
- [Audio viewer](/en/data/audio)
- [Storage settings](/en/data/storage)
- [Media logging](/en/tracking/media)
