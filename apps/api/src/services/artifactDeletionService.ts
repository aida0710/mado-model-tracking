import type { Artifact } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { rows, transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import {
  findArtifactReferences,
  type ArtifactReferenceKind,
} from '../repositories/artifactReferenceRepository.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { requireProject } from './accessService.js';
import { auditActor, NO_REQUEST_METADATA, recordDenial } from './auditService.js';

/** Who may delete: Project admins (decisions.md), with a token that may write Artifacts. */
export const ARTIFACT_DELETE_PERMISSION = { role: 'admin', scope: 'artifacts:write' } as const;

const referenceLabels: Record<ArtifactReferenceKind, string> = {
  model_version: '登録モデルバージョン',
  code_version: 'CodeVersion',
  dataset_version: 'DatasetVersion',
  checkpoint: '保持中のcheckpoint',
};

function artifactInUse(kinds: ArtifactReferenceKind[]): never {
  throw new DomainError(
    409,
    `${kinds.map((kind) => referenceLabels[kind]).join('・')}から参照されているため削除できません`,
    'artifact_in_use',
  );
}

type DeletionOrigin = 'native' | 'mlflow' | 'derived';

/**
 * Locks the Artifacts against new references before their references are checked: the triggers of
 * migration 049 take FOR KEY SHARE, which waits for this lock. Ordered by id to avoid deadlocks.
 */
async function lockLiveArtifacts(
  connection: Connection,
  location: { projectId: string; artifactIds: string[] },
): Promise<Artifact[]> {
  return rows<Artifact>(
    connection,
    `SELECT * FROM artifacts WHERE project_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL
     ORDER BY id FOR UPDATE`,
    [location.projectId, location.artifactIds],
  );
}

/**
 * Marks locked, unreferenced Artifacts deleted and removes what only describes them: media info,
 * Run media rows, MLflow path mappings and server-side previews (whose generated files are deleted
 * with them). Blobs stay until the garbage collector's grace period ends.
 */
async function markArtifactsDeleted(
  connection: Connection,
  deletion: { projectId: string; artifactIds: string[]; deletedBy: string; origin: DeletionOrigin },
): Promise<Artifact[]> {
  if (!deletion.artifactIds.length) return [];
  const deleted = await rows<Artifact>(
    connection,
    `UPDATE artifacts SET deleted_at=now()
     WHERE project_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL RETURNING *`,
    [deletion.projectId, deletion.artifactIds],
  );
  const ids = deleted.map((artifact) => artifact.id);
  if (!ids.length) return [];
  await connection.query(
    `INSERT INTO artifact_deletions(artifact_id,project_id,deleted_by,origin)
     SELECT id,$2,$3,$4 FROM unnest($1::uuid[]) AS id`,
    [ids, deletion.projectId, deletion.deletedBy, deletion.origin],
  );
  await connection.query('DELETE FROM artifact_media_info WHERE artifact_id=ANY($1::uuid[])', [
    ids,
  ]);
  await connection.query('DELETE FROM run_media WHERE artifact_id=ANY($1::uuid[])', [ids]);
  await connection.query(
    'UPDATE run_media SET thumbnail_artifact_id=NULL WHERE thumbnail_artifact_id=ANY($1::uuid[])',
    [ids],
  );
  await connection.query('DELETE FROM mlflow_artifact_paths WHERE artifact_id=ANY($1::uuid[])', [
    ids,
  ]);
  const previews = await rows<{ previewArtifactId: string | null }>(
    connection,
    `DELETE FROM artifact_previews
     WHERE artifact_id=ANY($1::uuid[]) OR preview_artifact_id=ANY($1::uuid[])
     RETURNING CASE WHEN artifact_id=ANY($1::uuid[]) THEN preview_artifact_id END AS preview_artifact_id`,
    [ids],
  );
  const generated = previews.flatMap((preview) =>
    preview.previewArtifactId ? [preview.previewArtifactId] : [],
  );
  if (generated.length) {
    await lockLiveArtifacts(connection, { projectId: deletion.projectId, artifactIds: generated });
    await markArtifactsDeleted(connection, {
      ...deletion,
      artifactIds: generated,
      origin: 'derived',
    });
  }
  return deleted;
}

/**
 * Deletes Artifacts on behalf of a Project admin. Deletion is soft: content answers 404 at once and
 * the blob is removed after MMT_ARTIFACT_DELETE_GRACE_DAYS by the ArtifactGarbageCollector.
 */
export class ArtifactDeletionService {
  constructor(private readonly database: Database) {}

  async delete(
    principal: Principal,
    location: { projectId: string; artifactId: string },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Artifact> {
    const draft = {
      ...auditActor(principal),
      action: 'artifact.delete',
      resourceType: 'artifact',
      resourceId: location.artifactId,
      projectId: location.projectId,
      ...request,
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await requireProject(connection, principal, {
          projectId: location.projectId,
          ...ARTIFACT_DELETE_PERMISSION,
        });
        const [artifact] = await lockLiveArtifacts(connection, {
          projectId: location.projectId,
          artifactIds: [location.artifactId],
        });
        if (!artifact) notFound('Artifact');
        const references = await findArtifactReferences(connection, {
          projectId: location.projectId,
          artifactIds: [artifact.id],
        });
        const kinds = references.get(artifact.id);
        if (kinds) artifactInUse(kinds);
        const [deleted] = await markArtifactsDeleted(connection, {
          projectId: location.projectId,
          artifactIds: [artifact.id],
          deletedBy: principal.user.id,
          origin: 'native',
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            path: artifact.path,
            runId: artifact.runId,
            backend: artifact.backend,
            size: artifact.size,
          },
        });
        return deleted!;
      }),
    );
  }

  /**
   * MLflow delete_artifacts for a Run path or directory ('' is the whole Run), inside the caller's
   * transaction that already authorized and locked the Run. Every version stored at the affected
   * paths is deleted unless something references it; kept versions stay hidden behind a mapping
   * without an Artifact, so neither API shows the path again until it is uploaded anew.
   */
  async deleteMlflowRunPath(
    connection: Connection,
    deletion: { principal: Principal; projectId: string; runId: string; path: string },
  ): Promise<{ deleted: number; kept: number }> {
    const stored = await rows<{ id: string; path: string }>(
      connection,
      `SELECT id,path FROM artifacts WHERE project_id=$1 AND run_id=$2 AND deleted_at IS NULL
       AND ($3='' OR path=$3 OR starts_with(path,$3 || '/'))`,
      [deletion.projectId, deletion.runId, deletion.path],
    );
    const result = await this.deleteUnreferenced(connection, {
      ...deletion,
      artifactIds: stored.map((artifact) => artifact.id),
    });
    const keptPaths = [
      ...new Set(stored.filter((artifact) => result.kept.has(artifact.id)).map(({ path }) => path)),
    ];
    // Deleted versions lost their mappings above; paths with a kept version get an empty mapping.
    await connection.query(
      `INSERT INTO mlflow_artifact_paths(project_id,owner_kind,owner_id,path,artifact_id)
       SELECT $1,'run',$2,path,NULL FROM unnest($3::text[]) AS path
       ON CONFLICT(project_id,owner_kind,owner_id,path) DO UPDATE SET artifact_id=NULL`,
      [deletion.projectId, deletion.runId, keptPaths],
    );
    return this.recordMlflowDeletion(connection, {
      ...deletion,
      owner: { kind: 'run', id: deletion.runId },
      result,
    });
  }

  /**
   * MLflow delete_artifacts for a Logged Model path, inside the caller's transaction. A Logged
   * Model lists only its mappings, so they are removed; mapped Artifacts nothing references are
   * deleted.
   */
  async deleteMlflowModelPath(
    connection: Connection,
    deletion: { principal: Principal; projectId: string; modelId: string; path: string },
  ): Promise<{ deleted: number; kept: number }> {
    const mappings = await rows<{ artifactId: string | null }>(
      connection,
      `DELETE FROM mlflow_artifact_paths WHERE project_id=$1 AND owner_kind='model' AND owner_id=$2
       AND ($3='' OR path=$3 OR starts_with(path,$3 || '/')) RETURNING artifact_id`,
      [deletion.projectId, deletion.modelId, deletion.path],
    );
    const result = await this.deleteUnreferenced(connection, {
      ...deletion,
      artifactIds: mappings.flatMap((mapping) => (mapping.artifactId ? [mapping.artifactId] : [])),
    });
    return this.recordMlflowDeletion(connection, {
      ...deletion,
      owner: { kind: 'model', id: deletion.modelId },
      result,
    });
  }

  private async recordMlflowDeletion(
    connection: Connection,
    deletion: {
      principal: Principal;
      projectId: string;
      owner: { kind: 'run' | 'model'; id: string };
      path: string;
      result: { deleted: number; kept: Set<string> };
    },
  ): Promise<{ deleted: number; kept: number }> {
    const summary = { deleted: deletion.result.deleted, kept: deletion.result.kept.size };
    await writeAuditEvent(connection, {
      ...auditActor(deletion.principal),
      action: 'artifact.mlflow_delete',
      outcome: 'success',
      resourceType: deletion.owner.kind === 'run' ? 'run' : 'logged_model',
      resourceId: deletion.owner.id,
      projectId: deletion.projectId,
      details: { path: deletion.path, ...summary },
    });
    return summary;
  }

  private async deleteUnreferenced(
    connection: Connection,
    deletion: { principal: Principal; projectId: string; artifactIds: string[] },
  ): Promise<{ deleted: number; kept: Set<string> }> {
    const locked = await lockLiveArtifacts(connection, deletion);
    const references = await findArtifactReferences(connection, {
      projectId: deletion.projectId,
      artifactIds: locked.map((artifact) => artifact.id),
    });
    const deleted = await markArtifactsDeleted(connection, {
      projectId: deletion.projectId,
      artifactIds: locked.filter((artifact) => !references.has(artifact.id)).map(({ id }) => id),
      deletedBy: deletion.principal.user.id,
      origin: 'mlflow',
    });
    return { deleted: deleted.length, kept: new Set(references.keys()) };
  }
}
