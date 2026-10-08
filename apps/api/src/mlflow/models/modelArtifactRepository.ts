import { first, rows, type Connection } from '../../db/database.js';
import { findRun } from '../../repositories/registryRepository.js';
import { notFound } from '../../domain/errors.js';
import { unsupported } from './validation.js';
import type { ArtifactManifestEntry, LoggedModelRecord, SavedModelArtifacts } from './types.js';
import { loggedModelArtifactUri } from './protocol.js';
import { artifactPath, validateFlavorArtifacts, validateModelManifest } from './modelManifest.js';

async function requireArtifactIndex(connection: Connection): Promise<void> {
  if (
    !(
      await first<{ present: boolean }>(
        connection,
        "SELECT to_regclass('mlflow_artifact_paths') IS NOT NULL AS present",
      )
    )?.present
  )
    unsupported('Artifact indexが未導入のためモデルを確定できません');
}

export async function loggedModelArtifacts(
  connection: Connection,
  model: LoggedModelRecord,
): Promise<SavedModelArtifacts> {
  await requireArtifactIndex(connection);
  const manifest = await rows<ArtifactManifestEntry>(
    connection,
    `SELECT paths.path,a.id AS artifact_id,a.sha256,a.size FROM mlflow_artifact_paths paths
      JOIN artifacts a ON a.id=paths.artifact_id AND a.project_id=paths.project_id
      WHERE paths.project_id=$1 AND paths.owner_kind='model' AND paths.owner_id=$2 ORDER BY paths.path`,
    [model.projectId, model.id],
  );
  validateModelManifest(manifest);
  validateFlavorArtifacts(manifest, model.metadata);
  return {
    manifest,
    artifactUri: loggedModelArtifactUri(model.id),
    sourceRunId: model.sourceRunId,
    loggedModelId: model.id,
    metadata: model.metadata,
    tags: model.tags,
  };
}

export async function runModelArtifacts(
  connection: Connection,
  input: { projectId: string; runId: string; directory: string },
): Promise<SavedModelArtifacts> {
  await requireArtifactIndex(connection);
  const run = await findRun(connection, { projectId: input.projectId, id: input.runId });
  if (
    !(await first(
      connection,
      `SELECT e.id FROM experiments e WHERE e.id=$1 AND e.project_id=$2 AND e.lifecycle_stage='active' FOR SHARE`,
      [run.experimentId, input.projectId],
    ))
  )
    notFound('Experiment');
  if (
    !(await first(
      connection,
      `SELECT id FROM runs WHERE id=$1 AND project_id=$2 AND lifecycle_stage='active' FOR NO KEY UPDATE`,
      [run.id, input.projectId],
    ))
  )
    notFound('Run');
  const prefix = input.directory ? `${artifactPath(input.directory)}/` : '';
  // Native uploads have no index entry; an existing index entry remains authoritative.
  const manifest = await rows<ArtifactManifestEntry>(
    connection,
    `WITH saved AS (
      SELECT paths.path,a.id AS artifact_id,a.sha256,a.size FROM mlflow_artifact_paths paths
      JOIN artifacts a ON a.id=paths.artifact_id AND a.project_id=paths.project_id
      WHERE paths.project_id=$1 AND paths.owner_kind='run' AND paths.owner_id=$2
    ), native_saved AS (
      SELECT DISTINCT ON(a.path) a.path,a.id AS artifact_id,a.sha256,a.size FROM artifacts a
      WHERE a.project_id=$1 AND a.run_id=$2::uuid AND a.deleted_at IS NULL AND NOT EXISTS(
        SELECT 1 FROM mlflow_artifact_paths paths WHERE paths.project_id=$1 AND paths.owner_kind='run' AND paths.owner_id=$2 AND paths.path=a.path
      ) ORDER BY a.path,a.created_at DESC,a.id DESC
    ), manifest AS (SELECT * FROM saved UNION ALL SELECT * FROM native_saved)
    SELECT substring(path FROM length($3::text)+1) AS path,artifact_id,sha256,size FROM manifest
    WHERE starts_with(path,$3) ORDER BY path`,
    [input.projectId, input.runId, prefix],
  );
  validateModelManifest(manifest);
  return {
    manifest,
    artifactUri: `mlflow-artifacts:/runs/${run.id}/artifacts${input.directory ? `/${input.directory}` : ''}`,
    sourceRunId: run.id,
    loggedModelId: null,
    metadata: {},
    tags: {},
  };
}
