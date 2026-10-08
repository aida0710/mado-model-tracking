import type { ArtifactUpload, ArtifactUploadPart } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import { notFound } from '../domain/errors.js';

/**
 * The session as stored, including the backend references and creator that clients never see.
 * expectedSize and partSize are null only while an MLflow session (ownerKind set) is not yet
 * completed by the client; native sessions always have them.
 */
export interface ArtifactUploadRecord extends ArtifactUpload {
  /** Set for MLflow multipart sessions: the Artifact path owner mapped on completion. */
  ownerKind: 'run' | 'model' | null;
  ownerId: string | null;
  storageKey: string;
  backendUploadId: string;
  createdByUserId: string;
  createdByTokenId: string | null;
  createdByJobTokenId: string | null;
  finalizerAttempts: number;
}

// bigint columns are cast so the mapped record holds numbers; sizes stay below 2^53.
export const artifactUploadColumns = `id,project_id,run_id,path,backend,storage_key,mime_type,
  expected_size::float8 AS expected_size,expected_sha256,part_size::float8 AS part_size,part_count,
  status,backend_upload_id,created_by_user_id,created_by_token_id,created_by_job_token_id,artifact_id,
  error,owner_kind,owner_id,
  finalizer_attempts,expires_at,created_at,updated_at`;

export async function findArtifactUpload(
  connection: Connection,
  reference: { projectId: string; id: string; lock?: boolean },
): Promise<ArtifactUploadRecord> {
  const upload = await first<ArtifactUploadRecord>(
    connection,
    `SELECT ${artifactUploadColumns} FROM artifact_uploads WHERE project_id=$1 AND id=$2
    ${reference.lock ? 'FOR UPDATE' : ''}`,
    [reference.projectId, reference.id],
  );
  if (!upload) notFound('Upload session');
  return upload;
}

export async function listArtifactUploadParts(
  connection: Connection,
  uploadId: string,
): Promise<(ArtifactUploadPart & { etag: string })[]> {
  return rows(
    connection,
    `SELECT part_number,size,sha256,etag,received_at FROM artifact_upload_parts
    WHERE upload_id=$1 ORDER BY part_number`,
    [uploadId],
  );
}

export function publicArtifactUpload(upload: ArtifactUploadRecord): ArtifactUpload {
  return {
    id: upload.id,
    projectId: upload.projectId,
    runId: upload.runId,
    path: upload.path,
    backend: upload.backend,
    mimeType: upload.mimeType,
    expectedSize: upload.expectedSize,
    expectedSha256: upload.expectedSha256,
    partSize: upload.partSize,
    partCount: upload.partCount,
    status: upload.status,
    artifactId: upload.artifactId,
    error: upload.error,
    expiresAt: upload.expiresAt,
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
  };
}

/** Every part except the last has the session's part size; the last holds the remainder. */
export function expectedPartBytes(
  upload: Pick<ArtifactUpload, 'expectedSize' | 'partSize' | 'partCount'>,
  partNumber: number,
): number {
  return partNumber < upload.partCount
    ? upload.partSize
    : upload.expectedSize - upload.partSize * (upload.partCount - 1);
}

/** Null when the Run does not exist in the Project. */
export async function runLifecycleStage(
  connection: Connection,
  reference: { projectId: string; runId: string },
): Promise<'active' | 'deleted' | null> {
  const run = await first<{ lifecycleStage: 'active' | 'deleted' }>(
    connection,
    'SELECT lifecycle_stage FROM runs WHERE project_id=$1 AND id=$2 FOR SHARE',
    [reference.projectId, reference.runId],
  );
  return run?.lifecycleStage ?? null;
}
