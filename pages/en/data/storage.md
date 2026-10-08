---
title: Storage settings
description: Add Artifact storage (file system or S3-compatible storage) in the global settings, run a connection test, and make it the default.
---

# Storage settings

![Storage tab of the global admin page](/images/data-storage.png)

Global administrators manage Artifact storage under **全体管理** (Global admin) → **ストレージ** (Storage). There are two kinds: a file system (Filesystem) and S3-compatible storage (S3). S3 works with AWS, S3-compatible services such as MinIO, and older services that do not accept Signature Version 4 (signature v2).

Each Project chooses which storage to use. Changing the storage does not move existing Artifacts; they are still read from the storage they were saved to.

The web UI is in Japanese. This page shows UI labels in Japanese followed by an English translation.

## When to use it

- You want to keep model weights and audio data on your own S3-compatible storage.
- You want separate buckets or prefixes per purpose and choose one per Project.
- You need to keep using storage that only accepts Signature Version 2.
- Your storage uses a certificate signed by an internal CA.

## Storage kinds

| Kind | Where files go | Configured by |
| --- | --- | --- |
| Filesystem | A directory on the API server | `ARTIFACT_FILESYSTEM_ROOT`, or the UI |
| S3 | A bucket on S3-compatible storage | `S3_*` environment variables, or the UI |

Each storage is identified by a name: lowercase letters, digits, and hyphens, up to 63 characters. The name cannot be changed later.

Storage defined by environment variables appears as `filesystem` (always present) and `s3` (when `S3_BUCKET` is set). Rows whose **定義元** (Defined by) column shows 環境変数 (environment variable) are read-only in the UI; edit `.env` and restart the API instead. See [Environment variables](/en/reference/environment).

## Add storage

To add S3-compatible storage:

1. Open **全体管理** (Global admin) in the top bar and select the **ストレージ** (Storage) tab.
2. Click **保存先を追加** (Add storage).
3. Set **種類** (Kind) to S3 and fill in the fields below.
4. Click **作成** (Create).

| Field | Value | Example |
| --- | --- | --- |
| 名前 (Name) | Lowercase letters, digits, and hyphens | `lab-minio` |
| Endpoint URL (leave empty for AWS) | A URL starting with `http://` or `https://`, without credentials or a query | `https://minio.example.internal:9000` |
| Region | AWS region. The default is fine for S3-compatible storage | `us-east-1` |
| Bucket | Bucket name | `mmt-artifacts` |
| Prefix (optional) | Folder inside the bucket. Leading and trailing `/` are removed | `tracking` |
| path-styleでアクセスする (Use path-style access) | Turn on for storage such as MinIO that cannot put the bucket name in the host name | On |
| 署名 (Signature) | Signature Version 4 (default) or Signature Version 2 | Signature Version 4 |
| TLS証明書を検証する (Verify TLS certificate) | On by default. Turn it off only in test environments | On |
| CA証明書 (CA certificate, PEM, optional) | Paste the CA certificate when the storage uses an internal CA | |
| Checksumの扱い (Checksum mode) | WHEN_REQUIRED (default) or WHEN_SUPPORTED | WHEN_REQUIRED |
| Multipart uploadを使う (Use multipart upload) | On by default | On |
| Multipartのpartサイズ (Multipart part size, MiB) | Size of each part when a large file is split. 5–512 MiB | `8` |
| Access key ID (optional) | Access key for the storage | |
| Secret access key | Secret key for the storage | |
| 有効 (Enabled) | Allow new Artifacts to be saved to this storage | On |

To add a file system, set **種類** (Kind) to Filesystem and enter an absolute path on the API server in **ルートディレクトリ** (Root directory), for example `/srv/mmt/artifacts`. Paths containing `..` are rejected. When you run several API servers, use a persistent volume that every server can see at the same path.

Storage you add appears with 画面 (UI) in the **定義元** column. The kind cannot be changed after saving.

### Credentials

The secret access key is encrypted in the API database and is never returned to the UI or API responses. When a key is set, the field shows 設定済み (configured); leaving it empty keeps the saved key. The CA certificate works the same way. Set both the access key ID and the secret access key, or leave both empty. When both are empty, the API uses the credentials available in its own environment (environment variables, instance roles, and so on).

To save secrets, the API needs the encryption key `MMT_STORAGE_SECRET_KEY` in its `.env`. Without it, storage with a secret cannot be saved. Generate a key in a terminal:

```sh
openssl rand -base64 32
```

Put the output after `MMT_STORAGE_SECRET_KEY=` in `.env` and restart the API. If you run the preview worker, give it the same value.

::: warning
Changing `MMT_STORAGE_SECRET_KEY` makes saved secrets impossible to decrypt. Artifacts on that storage become unreadable and the API logs `storage_backend_unavailable` at startup. After changing the key, open **変更** (Edit) for each storage and enter the secret access key again.
:::

### Signature v2

The AWS SDK only supports Signature Version 4, so Mado Model Tracking implements Signature Version 2 itself. Choose Signature Version 2 only for storage that does not accept v4.

- **Checksumの扱い** (Checksum mode) is hidden and requests use WHEN_REQUIRED.
- The region is not used for signing.
- The connection test and multipart upload work the same as with v4.

### Storage without multipart support

For S3-compatible storage that does not implement the multipart upload API, turn off **Multipart uploadを使う** (Use multipart upload). This has the following limits:

- One Artifact can be at most 5 GiB.
- The API writes the file to a temporary directory before sending it, so the API server needs the same amount of free temporary space.
- Resumable uploads described in [Large file uploads](/en/data/uploads) and MLflow multipart uploads are not available.

## Connection test

After adding or changing storage, run a connection test before making it the default.

1. Click **接続テスト** (Connection test) on the row.
2. **接続テストの結果** (Connection test result) shows OK or NG for each step.

The test writes a 64-byte file under `mmt-connection-test/<random ID>/` and checks these steps in order:

| Step | What it checks |
| --- | --- |
| 書き込み (Write) | The file can be saved |
| 読み出し (Read) | The whole file can be read back |
| 範囲指定の読み出し (Range read) | Part of the file can be read with a Range request (used for audio and video seeking) |
| 削除 (Delete) | The file can be deleted and is no longer readable afterwards |

When every step passes, the result reads すべての段階が成功しました (all steps succeeded). A failed step shows only the error name and HTTP status, never secrets or signatures. Steps after a failure are not run and show NG. If the write succeeded, the delete step is always attempted.

You can also test disabled storage and storage defined by environment variables.

For S3, allow Put, Get, and Delete on the prefix, and creating, completing, and aborting multipart uploads. Add an AbortIncompleteMultipartUpload lifecycle rule to the bucket so interrupted multipart uploads do not remain.

## Default storage

The default storage is preselected when someone creates a new Project.

1. Click **既定にする** (Make default) on the storage row.
2. Click **既定にする** (Make default) in the 既定の保存先を変更 (Change default storage) dialog.

The default storage is labeled 既定の保存先 (default storage). Changing the default does not change existing Projects. If no default is set, `filesystem` is the default.

## Choose storage for a Project

Choose a Project's storage in **Artifact保存先** (Artifact storage) when creating the Project. To change it later, select another storage in the プロジェクト (Project) section of the Project **Settings** and save. Only Project admins can change it.

After the change, only new Artifacts go to the new storage. Existing Artifacts stay where they are and are read from there.

## Disable storage

To retire storage, open **変更** (Edit) and turn off **有効** (Enabled).

- Existing Artifacts remain readable.
- Saving new Artifacts and starting new uploads is rejected. Uploads already in progress can finish.
- The storage is removed from the Project storage choices.

The default storage cannot be disabled. Make another storage the default first.

## Existing Artifacts

Each Artifact records the name of the storage it was saved to. While any Artifact remains on a storage, its kind, bucket, endpoint URL, prefix, and root directory cannot be changed, because existing Artifacts would become unreadable. To move to a new location, add storage with a new name and switch the Project to it.

Keep the old storage readable while Artifacts remain on it. Back up the database and Artifact storage at the same point in time; restoring only the database does not bring back weights or audio files.

Changes take effect immediately in the API process that received them. When you run several API processes, restart the API to apply enable/disable and part size changes everywhere.

## Related pages

- [Artifacts](/en/data/artifacts)
- [Large file uploads](/en/data/uploads)
- [Environment variables](/en/reference/environment)
