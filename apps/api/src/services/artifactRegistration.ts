import type { Artifact, ArtifactBackend } from '@mmt/contracts';
import type { ArtifactStores } from '@mmt/platform';
import { first, type Connection } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { isRelativeFilePath } from '../domain/validation.js';

// Matches the MLflow artifact path index column.
const MAX_ARTIFACT_PATH_LENGTH = 1024;

export function assertArtifactPath(path: string): void {
  if (!isRelativeFilePath(path) || path.length > MAX_ARTIFACT_PATH_LENGTH)
    throw new DomainError(422, 'Artifactには安全な相対パスが必要です', 'invalid_artifact_path');
}

/** New Artifacts go to the Project's current backend, which must be configured on this server. */
export async function projectArtifactBackend(
  connection: Connection,
  projectId: string,
  stores: ArtifactStores,
): Promise<ArtifactBackend> {
  const project = (await first<{ artifactBackend: ArtifactBackend }>(
    connection,
    'SELECT artifact_backend FROM projects WHERE id=$1',
    [projectId],
  ))!;
  if (!stores.backends().includes(project.artifactBackend))
    throw new DomainError(503, 'Artifact保存先が設定されていません', 'backend_unavailable');
  return project.artifactBackend;
}

/** Runs inside the registering transaction, so a failed mapping leaves no visible Artifact. */
export type ArtifactStoredHook = (connection: Connection, artifact: Artifact) => Promise<void>;

export interface StoredArtifactRecord {
  id: string;
  projectId: string;
  runId: string | null;
  path: string;
  backend: ArtifactBackend;
  storageKey: string;
  mimeType: string;
  size: number;
  sha256: string;
}

/**
 * Registers bytes already written to storage. Single-request uploads and upload sessions both
 * end here, so they produce identical Artifacts and run the same compatibility hooks.
 */
export async function registerStoredArtifact(
  connection: Connection,
  record: StoredArtifactRecord,
  onStored?: ArtifactStoredHook,
): Promise<Artifact> {
  const artifact = (await first<Artifact>(
    connection,
    `INSERT INTO artifacts(id,project_id,run_id,path,backend,storage_key,mime_type,size,sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      record.id,
      record.projectId,
      record.runId,
      record.path,
      record.backend,
      record.storageKey,
      record.mimeType,
      record.size,
      record.sha256,
    ],
  ))!;
  await onStored?.(connection, artifact);
  return artifact;
}
