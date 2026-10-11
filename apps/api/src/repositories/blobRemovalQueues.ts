import type { ArtifactBackend } from '@mmt/contracts';
import { rows, type Connection } from '../db/database.js';

/** A blob that only a deleted row named, waiting for the ArtifactGarbageCollector. */
export interface QueuedBlob {
  /** Identifies the blob within its queue. */
  id: string;
  backend: ArtifactBackend;
  storageKey: string;
}

/**
 * Where removable blobs are recorded and how their removal is written back. Both queues keep the
 * row after removal (removed_at / blob_removed_at), so a run cut short is finished by the next.
 */
export interface BlobRemovalQueue {
  /** The id field name used in logs, next to the error name only (storage keys are not logged). */
  logIdField: string;
  /** Blobs queued at or before `queuedBefore`, oldest first, without those listed in `excluded`. */
  due(
    connection: Connection,
    filter: { queuedBefore: Date; excluded: readonly string[]; limit: number },
  ): Promise<QueuedBlob[]>;
  markRemoved(connection: Connection, blob: QueuedBlob): Promise<void>;
  markFailed(
    connection: Connection,
    failure: { blob: QueuedBlob; errorName: string },
  ): Promise<void>;
}

/** Blobs of Artifacts deleted through the Artifact API or MLflow (migration 049). */
export const deletedArtifactBlobs: BlobRemovalQueue = {
  logIdField: 'artifactId',
  due: (connection, filter) =>
    rows<QueuedBlob>(
      connection,
      `SELECT a.id,a.backend,a.storage_key FROM artifact_deletions d
       JOIN artifacts a ON a.id=d.artifact_id
       WHERE d.blob_removed_at IS NULL AND a.deleted_at<=$1 AND NOT d.artifact_id=ANY($2::uuid[])
       ORDER BY a.deleted_at,a.id LIMIT $3`,
      [filter.queuedBefore, filter.excluded, filter.limit],
    ),
  markRemoved: async (connection, blob) => {
    await connection.query(
      `UPDATE artifact_deletions SET blob_removed_at=now(),last_removal_error=NULL
       WHERE artifact_id=$1 AND blob_removed_at IS NULL`,
      [blob.id],
    );
  },
  markFailed: async (connection, { blob, errorName }) => {
    await connection.query(
      `UPDATE artifact_deletions SET removal_attempts=removal_attempts+1,last_removal_error=$2
       WHERE artifact_id=$1`,
      [blob.id, errorName],
    );
  },
};

/** Blobs of purged Projects (migration 055); their Artifact rows are gone. */
export const purgedProjectBlobs: BlobRemovalQueue = {
  logIdField: 'purgedProjectBlobId',
  due: (connection, filter) =>
    rows<QueuedBlob>(
      connection,
      `SELECT id,backend,storage_key FROM purged_project_blobs
       WHERE removed_at IS NULL AND queued_at<=$1 AND NOT id=ANY($2::uuid[])
       ORDER BY queued_at,id LIMIT $3`,
      [filter.queuedBefore, filter.excluded, filter.limit],
    ),
  markRemoved: async (connection, blob) => {
    await connection.query(
      `UPDATE purged_project_blobs SET removed_at=now(),last_removal_error=NULL
       WHERE id=$1 AND removed_at IS NULL`,
      [blob.id],
    );
  },
  markFailed: async (connection, { blob, errorName }) => {
    await connection.query(
      `UPDATE purged_project_blobs SET removal_attempts=removal_attempts+1,last_removal_error=$2
       WHERE id=$1`,
      [blob.id, errorName],
    );
  },
};
