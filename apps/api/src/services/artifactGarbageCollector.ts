import type { ArtifactStores } from '@mmt/platform';
import type { Database } from '../db/database.js';
import {
  deletedArtifactBlobs,
  purgedProjectBlobs,
  type BlobRemovalQueue,
  type QueuedBlob,
} from '../repositories/blobRemovalQueues.js';
import { PollingLoop } from './pollingLoop.js';
import type { ArtifactUploadSweep, ArtifactUploadSweeper } from './artifactUploadSweeper.js';

// The upload sweeper ran on this cadence before the collector took it over; blob removal after a
// grace period of days is not sensitive to minutes either.
const COLLECT_INTERVAL_MS = 10 * 60 * 1000;
// One query's worth of blobs; a run keeps taking batches until no due blob is left.
const REMOVAL_BATCH_SIZE = 200;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
// Matches last_removal_error of artifact_deletions and purged_project_blobs.
const MAX_ERROR_NAME_LENGTH = 64;

export interface ArtifactGarbageCollection {
  /** Blobs of deleted Artifacts and purged Projects removed in this run. */
  removedBlobs: number;
  /** Blobs whose removal failed; they are retried on the next run. */
  failedBlobs: number;
  uploads: ArtifactUploadSweep;
}

// Deleted Artifacts first: they are the usual case and their grace period started earlier.
const BLOB_REMOVAL_QUEUES: readonly BlobRemovalQueue[] = [deletedArtifactBlobs, purgedProjectBlobs];

/**
 * Removes storage nothing points to any more: blobs of Artifacts deleted, or of Projects purged,
 * longer ago than the grace period, and (through ArtifactUploadSweeper) expired upload sessions,
 * orphaned multipart uploads and abandoned staging files. The deletion is already committed in the
 * DB before a blob is touched, and removing a missing blob succeeds, so a run cut short is
 * finished by the next one.
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
    const queuedBefore = new Date(
      now.getTime() - this.options.deleteGraceDays * MILLISECONDS_PER_DAY,
    );
    let removedBlobs = 0;
    let failedBlobs = 0;
    for (const queue of BLOB_REMOVAL_QUEUES) {
      const emptied = await this.emptyQueue(queue, queuedBefore);
      removedBlobs += emptied.removedBlobs;
      failedBlobs += emptied.failedBlobs;
    }
    return { removedBlobs, failedBlobs, uploads: await this.options.uploadSweeper.sweep(now) };
  }

  private async emptyQueue(
    queue: BlobRemovalQueue,
    queuedBefore: Date,
  ): Promise<Pick<ArtifactGarbageCollection, 'removedBlobs' | 'failedBlobs'>> {
    let removedBlobs = 0;
    const failed: string[] = [];
    for (;;) {
      const due = await queue.due(this.options.database, {
        queuedBefore,
        excluded: failed,
        limit: REMOVAL_BATCH_SIZE,
      });
      for (const blob of due) {
        if (await this.removeBlob(queue, blob)) removedBlobs++;
        else failed.push(blob.id);
      }
      if (due.length < REMOVAL_BATCH_SIZE) return { removedBlobs, failedBlobs: failed.length };
    }
  }

  private async removeBlob(queue: BlobRemovalQueue, blob: QueuedBlob): Promise<boolean> {
    try {
      // The blob's own backend, which stays readable (and removable) after it is disabled.
      await this.options.stores.remove({ backend: blob.backend, key: blob.storageKey });
    } catch (error) {
      const errorName = ((error as Error)?.name ?? 'Error').slice(0, MAX_ERROR_NAME_LENGTH);
      await queue.markFailed(this.options.database, { blob, errorName });
      // Only the immutable id and the error name: storage keys can reveal bucket layout.
      console.error(
        JSON.stringify({
          event: 'artifact_blob_removal_failed',
          [queue.logIdField]: blob.id,
          name: errorName,
        }),
      );
      return false;
    }
    await queue.markRemoved(this.options.database, blob);
    return true;
  }
}
