import type { Artifact } from '@mmt/contracts';
import { first, rows, type Connection } from '../../db/database.js';
import { DomainError, notFound } from '../../domain/errors.js';
import { currentRunArtifactCondition } from '../../services/artifactListing.js';
import { isSafeArtifactPath, nativeArtifactPath } from './artifactPath.js';
import type { ArtifactAccess, ArtifactPathEntry } from './artifactTypes.js';

export async function listArtifactPaths(
  connection: Connection,
  access: ArtifactAccess,
): Promise<ArtifactPathEntry[]> {
  const indexedSql = `SELECT p.path,p.artifact_id,a.size FROM mlflow_artifact_paths p
     JOIN artifacts a ON a.id=p.artifact_id AND a.project_id=p.project_id AND a.deleted_at IS NULL
     WHERE p.project_id=$1 AND p.owner_kind=$2 AND p.owner_id=$3`;
  const parameters = [access.projectId, access.owner.kind, access.owner.id];
  if (access.owner.kind === 'model')
    return rows<ArtifactPathEntry>(connection, indexedSql, parameters);
  // One statement keeps a single snapshot, so a mapping committing meanwhile cannot drop a file.
  const artifacts = await rows<ArtifactPathEntry>(
    connection,
    `SELECT a.path,a.id AS artifact_id,a.size FROM artifacts a
     WHERE a.project_id=$1 AND a.run_id=$2::uuid AND a.deleted_at IS NULL
       AND ${currentRunArtifactCondition('a')}`,
    [access.projectId, access.owner.id],
  );
  return artifacts.filter((artifact) => isSafeArtifactPath(artifact.path));
}

export async function findArtifactPath(
  connection: Connection,
  access: ArtifactAccess & { path: string },
): Promise<string> {
  const indexedSql = `SELECT artifact_id FROM mlflow_artifact_paths
    WHERE project_id=$1 AND owner_kind=$2 AND owner_id=$3 AND path=$4`;
  const sql =
    access.owner.kind === 'model'
      ? indexedSql
      : `WITH indexed AS (${indexedSql}), native AS (
       SELECT id AS artifact_id FROM artifacts
       WHERE project_id=$1 AND run_id=$3::uuid AND path=$4 AND deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM indexed) ORDER BY created_at DESC,id DESC LIMIT 1
     ) SELECT * FROM indexed UNION ALL SELECT * FROM native`;
  // A mapping without an Artifact is a path removed by MLflow delete_artifacts.
  const artifact = await first<{ artifactId: string | null }>(connection, sql, [
    access.projectId,
    access.owner.kind,
    access.owner.id,
    access.path,
  ]);
  if (!artifact?.artifactId) notFound('Artifact');
  return artifact.artifactId;
}

export async function requireNonconflictingArtifactPath(
  connection: Connection,
  access: ArtifactAccess & { path: string },
): Promise<void> {
  const artifacts = await listArtifactPaths(connection, access);
  if (
    artifacts.some(
      (artifact) =>
        artifact.path.startsWith(`${access.path}/`) || access.path.startsWith(`${artifact.path}/`),
    )
  )
    throw new DomainError(409, 'Artifactのファイルとディレクトリが衝突しています', 'conflict');
}

export async function replaceArtifactPath(
  connection: Connection,
  upload: ArtifactAccess & { path: string; artifact: Artifact; runId: string | null },
): Promise<void> {
  const expectedPath = nativeArtifactPath(upload);
  if (
    upload.artifact.projectId !== upload.projectId ||
    upload.artifact.path !== expectedPath ||
    upload.artifact.runId !== upload.runId
  )
    throw new DomainError(503, 'Artifactの保存参照が一致しません', 'artifact_save_failed');
  await connection.query(
    `INSERT INTO mlflow_artifact_paths(project_id,owner_kind,owner_id,path,artifact_id)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(project_id,owner_kind,owner_id,path) DO UPDATE SET artifact_id=EXCLUDED.artifact_id`,
    [upload.projectId, upload.owner.kind, upload.owner.id, upload.path, upload.artifact.id],
  );
}
