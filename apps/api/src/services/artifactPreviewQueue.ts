import type { Artifact, ArtifactPreviewKind } from '@mmt/contracts';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';

// A claim older than this belongs to a worker that died: the whole job (download, probe, decode,
// poster) is bounded by a few tool timeouts (MMT_PREVIEW_TOOL_TIMEOUT_MS, default 30 min each).
export const PREVIEW_LEASE_SECONDS = 2 * 60 * 60;
// Storage hiccups and worker crashes are retried; a file ffmpeg cannot read fails at once.
export const PREVIEW_MAX_ATTEMPTS = 3;

/** The unfinished previews of one Artifact, claimed together so its file is downloaded once. */
export interface PreviewJob {
  artifact: Artifact;
  /** attempts after this claim, per kind; finishing a kind requires the same value. */
  attempts: Map<ArtifactPreviewKind, number>;
}

export interface PreviewOutcome {
  artifactId: string;
  kind: ArtifactPreviewKind;
  attempts: number;
}

/** Queued, or claimed by a worker whose lease ($1 seconds) ran out. */
function claimableCondition(table: string): string {
  return `(${table}.status='queued' OR (${table}.status='running' AND ${table}.updated_at < now() - make_interval(secs => $1)))`;
}

/** Gives up on previews whose worker died too many times, so they do not loop forever. */
async function failExhaustedClaims(database: Database): Promise<void> {
  await database.query(
    `UPDATE artifact_previews SET status='failed',error='lease_expired',updated_at=now()
     WHERE status='running' AND updated_at < now() - make_interval(secs => $1) AND attempts >= $2`,
    [PREVIEW_LEASE_SECONDS, PREVIEW_MAX_ATTEMPTS],
  );
}

export async function claimNextPreviewJob(database: Database): Promise<PreviewJob | null> {
  await failExhaustedClaims(database);
  return transaction(database, async (connection) => {
    // SKIP LOCKED lets several workers claim different Artifacts; the outer WHERE is re-checked
    // after locking, so a row another worker claimed in between is not claimed twice.
    const claimed = await rows<{ artifactId: string; kind: ArtifactPreviewKind; attempts: number }>(
      connection,
      `WITH target AS (
         SELECT artifact_id FROM artifact_previews candidate WHERE ${claimableCondition('candidate')}
         ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       UPDATE artifact_previews p
       SET status='running',attempts=p.attempts+1,error=NULL,updated_at=now()
       FROM target WHERE p.artifact_id=target.artifact_id AND ${claimableCondition('p')}
       RETURNING p.artifact_id,p.kind,p.attempts`,
      [PREVIEW_LEASE_SECONDS],
    );
    if (claimed.length === 0) return null;
    const artifact = (await first<Artifact>(connection, 'SELECT * FROM artifacts WHERE id=$1', [
      claimed[0]!.artifactId,
    ]))!;
    return {
      artifact,
      attempts: new Map(claimed.map((row) => [row.kind, row.attempts])),
    };
  });
}

/** False when the claim was lost (lease expired and another worker took over). */
export async function markPreviewReady(
  connection: Connection,
  outcome: PreviewOutcome & { previewArtifactId: string },
): Promise<boolean> {
  const result = await connection.query(
    `UPDATE artifact_previews SET status='ready',preview_artifact_id=$4,error=NULL,updated_at=now()
     WHERE artifact_id=$1 AND kind=$2 AND attempts=$3 AND status='running'`,
    [outcome.artifactId, outcome.kind, outcome.attempts, outcome.previewArtifactId],
  );
  return result.rowCount === 1;
}

export async function markPreviewFinished(
  database: Database,
  outcome: PreviewOutcome & { status: 'failed' | 'skipped'; error: string },
): Promise<void> {
  await database.query(
    `UPDATE artifact_previews SET status=$4,error=$5,updated_at=now()
     WHERE artifact_id=$1 AND kind=$2 AND attempts=$3 AND status='running'`,
    [outcome.artifactId, outcome.kind, outcome.attempts, outcome.status, outcome.error],
  );
}

/** Puts a preview back in the queue after a transient failure, or fails it after the last try. */
export async function retryPreviewLater(
  database: Database,
  outcome: PreviewOutcome & { error: string },
): Promise<void> {
  await database.query(
    `UPDATE artifact_previews
     SET status=CASE WHEN attempts >= $4 THEN 'failed' ELSE 'queued' END,error=$5,updated_at=now()
     WHERE artifact_id=$1 AND kind=$2 AND attempts=$3 AND status='running'`,
    [outcome.artifactId, outcome.kind, outcome.attempts, PREVIEW_MAX_ATTEMPTS, outcome.error],
  );
}
