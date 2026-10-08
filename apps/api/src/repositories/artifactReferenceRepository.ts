import { rows, type Connection } from '../db/database.js';

/** Records that keep an Artifact's bytes alive; while any exists the Artifact cannot be deleted. */
export type ArtifactReferenceKind =
  'model_version' | 'code_version' | 'dataset_version' | 'checkpoint';

/**
 * One SQL condition per reference kind, for an artifacts row aliased `artifact`. Registered model
 * versions point at an Artifact directly or through their immutable MLflow manifest. A checkpoint
 * protects its files while it is retained or a Run continues from it; hidden checkpoints
 * (retained=false) do not, which is how old checkpoint files become deletable.
 */
function referenceConditions(artifact: string): Record<ArtifactReferenceKind, string> {
  return {
    model_version: `EXISTS(SELECT 1 FROM model_versions version
      WHERE version.project_id=${artifact}.project_id AND (version.artifact_id=${artifact}.id
        OR version.metadata #> '{mlflow,artifactManifest}'
           @> jsonb_build_array(jsonb_build_object('artifactId',${artifact}.id::text))))`,
    code_version: `EXISTS(SELECT 1 FROM code_versions code
      WHERE code.project_id=${artifact}.project_id
        AND (code.source->>'artifactId'=${artifact}.id::text
          OR code.runtime->>'artifactId'=${artifact}.id::text))`,
    dataset_version: `EXISTS(SELECT 1 FROM dataset_version_files file
      WHERE file.artifact_id=${artifact}.id)`,
    checkpoint: `EXISTS(SELECT 1 FROM run_checkpoints checkpoint
      WHERE checkpoint.project_id=${artifact}.project_id
        AND checkpoint.artifact_ids @> ARRAY[${artifact}.id]
        AND (checkpoint.retained OR EXISTS(SELECT 1 FROM runs resumed
          WHERE resumed.resume_checkpoint_id=checkpoint.id)))`,
  };
}

/** SQL condition that is true when nothing keeps the Artifact aliased `artifact`. */
export function unreferencedArtifactCondition(artifact: string): string {
  return `NOT (${Object.values(referenceConditions(artifact)).join(' OR ')})`;
}

/** The reference kinds of each given Artifact that has any; unreferenced Artifacts are absent. */
export async function findArtifactReferences(
  connection: Connection,
  location: { projectId: string; artifactIds: string[] },
): Promise<Map<string, ArtifactReferenceKind[]>> {
  const conditions = Object.entries(referenceConditions('a')) as [ArtifactReferenceKind, string][];
  const found = await rows<{ id: string; kinds: (ArtifactReferenceKind | null)[] }>(
    connection,
    `SELECT a.id,ARRAY[${conditions
      .map(([kind, condition]) => `CASE WHEN ${condition} THEN '${kind}' END`)
      .join(',')}] AS kinds
     FROM artifacts a WHERE a.project_id=$1 AND a.id=ANY($2::uuid[])`,
    [location.projectId, location.artifactIds],
  );
  const references = new Map<string, ArtifactReferenceKind[]>();
  for (const artifact of found) {
    const kinds = artifact.kinds.filter((kind): kind is ArtifactReferenceKind => kind !== null);
    if (kinds.length) references.set(artifact.id, kinds);
  }
  return references;
}
