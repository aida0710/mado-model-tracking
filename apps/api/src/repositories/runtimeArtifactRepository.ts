import type { Artifact, CodeSource, ExecutionRuntime } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';

export async function findSavedArtifact(
  connection: Connection,
  reference: { projectId: string; artifactId: string },
): Promise<Artifact> {
  // Artifact rows are inserted only after the streaming store write has completed.
  const artifact = await first<Artifact>(
    connection,
    'SELECT * FROM artifacts WHERE id=$1 AND project_id=$2',
    [reference.artifactId, reference.projectId],
  );
  if (!artifact) notFound('Artifact');
  return artifact;
}

export async function validateCodeArtifacts(
  connection: Connection,
  code: {
    projectId: string;
    source: CodeSource | null;
    runtime: ExecutionRuntime;
  },
): Promise<void> {
  if (code.source?.kind === 'artifact')
    await findSavedArtifact(connection, {
      projectId: code.projectId,
      artifactId: code.source.artifactId,
    });
  if (code.runtime.kind !== 'singularity' && code.runtime.kind !== 'apptainer') return;
  const artifact = await findSavedArtifact(connection, {
    projectId: code.projectId,
    artifactId: code.runtime.artifactId,
  });
  if (artifact.sha256 !== code.runtime.sha256)
    throw new DomainError(422, 'SIF ArtifactのSHA256が一致しません', 'artifact_hash_mismatch');
}
