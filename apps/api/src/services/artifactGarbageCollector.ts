import type { ArtifactBackend } from '@mmt/contracts';
import type { ArtifactStores } from '@mmt/platform';
import { rows, type Database } from '../db/database.js';
import { PollingLoop } from './pollingLoop.js';
import type { ArtifactUploadSweep, ArtifactUploadSweeper } from './artifactUploadSweeper.js';

// The upload sweeper ran on this cadence before the collector took it over; blob removal after a
// grace period of days is not sensitive to minutes either.
const COLLECT_INTERVAL_MS = 10 * 60 * 1000;
// One query's worth of blobs; a run keeps taking batches until no due blob is left.
const PURGE_BATCH_SIZE = 200;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
// Matches artifact_deletions.last_removal_error.
const MAX_ERROR_NAME_LENGTH = 64;

export interface ArtifactGarbageCollection {
  /** Blobs of deleted Artifacts removed in this run. */
  removedBlobs: number;
  /** Blobs whose removal failed; they are retried on the next run. */
  failedBlobs: number;
  uploads: ArtifactUploadSweep;
}

interface DueBlob {
  artifactId: string;
  backend: ArtifactBackend;
  storageKey: string;
}

/**
 * Removes storage nothing points to any more: blobs of Artifacts deleted longer ago than the
 * grace period, and (through ArtifactUploadSweeper) expired upload sessions, orphaned multipart
 * uploads and abandoned staging files. The deletion is already committed in the DB before a blob
 * is touched, and removing a missing blob succeeds, so a run cut short is finished by the next one.
 */
export class ArtifactGarbageCollector {
  private readonly loop = new PollingLoop({
    intervalMs: COLLECT_INTERVAL_MS,
    run: () => this.collect(),
    failureEvent: 'artifact_garbage_collection_failed',
  });

  constructor(
    private readonly options: {
      database: Database;
      stores: ArtifactStores;
      uploadSweeper: ArtifactUploadSweeper;
      deleteGraceDays: number;
    },
  ) {}

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  async collect(now = new Date()): Promise<ArtifactGarbageCollection> {
    const purge = await this.purgeDeletedBlobs(
      new Date(now.getTime() - this.options.deleteGraceDays * MILLISECONDS_PER_DAY),
    );
    return { ...purge, uploads: await this.options.uploadSweeper.sweep(now) };
  }

  private async purgeDeletedBlobs(
    deletedBefore: Date,
  ): Promise<Pick<ArtifactGarbageCollection, 'removedBlobs' | 'failedBlobs'>> {
    let removedBlobs = 0;
    const failed: string[] = [];
    for (;;) {
      const due = await this.dueBlobs({ deletedBefore, excluded: failed });
      for (const blob of due) {
        if (await this.removeBlob(blob)) removedBlobs++;
        else failed.push(blob.artifactId);
      }
      if (due.length < PURGE_BATCH_SIZE) return { removedBlobs, failedBlobs: failed.length };
    }
  }

  private dueBlobs(filter: { deletedBefore: Date; excluded: string[] }): Promise<DueBlob[]> {
    return rows<DueBlob>(
      this.options.database,
      `SELECT a.id AS artifact_id,a.backend,a.storage_key FROM artifact_deletions d
       JOIN artifacts a ON a.id=d.artifact_id
       WHERE d.blob_removed_at IS NULL AND a.deleted_at<=$1 AND NOT d.artifact_id=ANY($2::uuid[])
       ORDER BY a.deleted_at,a.id LIMIT $3`,
      [filter.deletedBefore, filter.excluded, PURGE_BATCH_SIZE],
    );
  }

  private async removeBlob(blob: DueBlob): Promise<boolean> {
    try {
      // The Artifact's own backend, which stays readable (and removable) after it is disabled.
      await this.options.stores.remove({ backend: blob.backend, key: blob.storageKey });
    } catch (error) {
      const errorName = ((error as Error)?.name ?? 'Error').slice(0, MAX_ERROR_NAME_LENGTH);
      await this.options.database.query(
        `UPDATE artifact_deletions SET removal_attempts=removal_attempts+1,last_removal_error=$2
         WHERE artifact_id=$1`,
        [blob.artifactId, errorName],
      );
      // Only the immutable id and the error name: storage keys can reveal bucket layout.
      console.error(
        JSON.stringify({
          event: 'artifact_blob_removal_failed',
          artifactId: blob.artifactId,
          name: errorName,
        }),
      );
      return false;
    }
    await this.options.database.query(
      `UPDATE artifact_deletions SET blob_removed_at=now(),last_removal_error=NULL
       WHERE artifact_id=$1 AND blob_removed_at IS NULL`,
      [blob.artifactId],
    );
    return true;
  }
}
