import { z } from 'zod';
import { first, rows, type Connection } from '../../db/database.js';
import { DomainError, notFound } from '../../domain/errors.js';
import { uuidSchema } from '../../domain/validation.js';
import { isSafeArtifactPath } from './artifactPath.js';
import type { ArtifactAccess, ArtifactPathEntry } from './artifactTypes.js';

const manifestSchema = z.array(
  z.object({
    path: z.string().refine(isSafeArtifactPath),
    artifactId: uuidSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
);

export async function modelVersionArtifactManifest(
  connection: Connection,
  access: ArtifactAccess,
): Promise<ArtifactPathEntry[]> {
  const version = await first<{ metadata: { mlflow?: { artifactManifest?: unknown } } }>(
    connection,
    `SELECT v.metadata FROM model_versions v
     JOIN models m ON m.id=v.model_id AND m.project_id=v.project_id
     LEFT JOIN mlflow_model_version_metadata vm ON vm.version_id=v.id AND vm.project_id=v.project_id
     LEFT JOIN mlflow_registered_model_metadata mm ON mm.model_id=m.id AND mm.project_id=m.project_id
     WHERE v.id=$1 AND v.project_id=$2 AND vm.deleted_at IS NULL AND mm.deleted_at IS NULL`,
    [access.owner.id, access.projectId],
  );
  if (!version) notFound('ModelVersion');
  const manifest = manifestSchema.safeParse(version.metadata.mlflow?.artifactManifest);
  if (
    !manifest.success ||
    !manifest.data.length ||
    new Set(manifest.data.map((entry) => entry.path)).size !== manifest.data.length
  )
    throw new DomainError(409, '登録モデル版のArtifact manifestが不正です', 'invalid_reference');
  // Resolve only the immutable snapshot; source Run and Logged Model lifecycle do not affect a registered version.
  const artifacts = await rows<{ id: string; sha256: string; size: number }>(
    connection,
    'SELECT id,sha256,size FROM artifacts WHERE project_id=$1 AND id=ANY($2::uuid[])',
    [access.projectId, manifest.data.map((entry) => entry.artifactId)],
  );
  const saved = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const entry of manifest.data) {
    const artifact = saved.get(entry.artifactId);
    if (!artifact) notFound('Artifact');
    if (artifact.sha256 !== entry.sha256 || artifact.size !== entry.size)
      throw new DomainError(409, '登録モデル版のArtifact参照が一致しません', 'invalid_reference');
  }
  return manifest.data;
}
