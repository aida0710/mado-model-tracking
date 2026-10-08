import type { Dataset, DatasetVersion, JsonObject, Run } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import { assertProjectReferences, findRun } from '../repositories/registryRepository.js';
import { runColumns } from '../repositories/runListProjection.js';
import { requireProject } from './accessService.js';
import type { ModelVersionRegistrationActor } from './modelVersionRegistration.js';
import { enqueueRunEvent } from './outboxEvents.js';

// Dataset versions are registered by the same two kinds of actor as model versions.
export type DatasetVersionRegistrationActor = ModelVersionRegistrationActor;

export interface DatasetVersionRegistration {
  projectId: string;
  datasetId: string;
  // Omitted versions take the next integer after the dataset's integer versions.
  version?: string;
  uri: string;
  digest: string;
  schema: JsonObject;
  metadata: JsonObject;
  sourceRunId?: string | null;
  parentDatasetVersionIds: string[];
  actor: DatasetVersionRegistrationActor;
}

// Non-integer versions ("2026-10", "v1") stay as they are and do not take part in numbering.
// 18 digits keeps the value inside bigint.
const INTEGER_VERSION_PATTERN = '^[1-9][0-9]{0,17}$';

/**
 * Inserts an immutable DatasetVersion in the caller's transaction and lists it in the source
 * Run's outputs. A registration that arrives after the Run ended resends the Run's outbox event
 * so external lineage sees the new output.
 */
export async function registerDatasetVersion(
  connection: Connection,
  registration: DatasetVersionRegistration,
): Promise<DatasetVersion> {
  const { projectId, actor } = registration;
  if (actor.type === 'principal')
    await requireProject(connection, actor.principal, {
      projectId,
      role: 'editor',
      scope: 'registry:write',
    });
  const dataset = await first<Dataset>(
    connection,
    `SELECT * FROM datasets WHERE id=$1 AND project_id=$2 ${registration.version ? '' : 'FOR UPDATE'}`,
    [registration.datasetId, projectId],
  );
  if (!dataset) notFound('Dataset');
  await assertProjectReferences(connection, {
    table: 'dataset_versions',
    projectId,
    ids: registration.parentDatasetVersionIds,
  });
  const sourceRun = registration.sourceRunId
    ? await findRun(connection, {
        projectId,
        id: registration.sourceRunId,
        lock: true,
      })
    : null;
  if (actor.type === 'runCreator') {
    if (!sourceRun)
      throw new DomainError(
        422,
        'Runの作成者として登録するにはsourceRunIdが必要です',
        'source_run_required',
      );
    await requireRunCreatorRegistryAccess(connection, {
      projectId,
      userId: sourceRun.createdBy,
    });
  }
  const version = registration.version ?? (await nextDatasetVersion(connection, dataset.id));
  const inserted = (await first<Omit<DatasetVersion, 'name' | 'namespace'>>(
    connection,
    `INSERT INTO dataset_versions(dataset_id,project_id,version,uri,digest,schema,metadata,source_run_id,parent_dataset_version_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      dataset.id,
      projectId,
      version,
      registration.uri,
      registration.digest,
      JSON.stringify(registration.schema),
      JSON.stringify(registration.metadata),
      sourceRun?.id ?? null,
      registration.parentDatasetVersionIds,
    ],
  ))!;
  if (sourceRun) {
    const updatedRun = (await first<Run>(
      connection,
      `UPDATE runs SET output_dataset_version_ids=array_append(output_dataset_version_ids,$2::uuid) WHERE id=$1 RETURNING ${runColumns}`,
      [sourceRun.id, inserted.id],
    ))!;
    if (isTerminalStatus(updatedRun.status)) await enqueueRunEvent(connection, updatedRun);
  }
  return { ...inserted, name: dataset.name, namespace: dataset.namespace };
}

// The caller holds the dataset row FOR UPDATE, so concurrent registrations take distinct numbers.
async function nextDatasetVersion(connection: Connection, datasetId: string): Promise<string> {
  const next = (await first<{ version: string }>(
    connection,
    `SELECT (COALESCE(MAX(version::bigint),0)+1)::text AS version FROM dataset_versions
    WHERE dataset_id=$1 AND version ~ '${INTEGER_VERSION_PATTERN}'`,
    [datasetId],
  ))!;
  return next.version;
}

// Same rule as modelVersionRegistration.ts: the system actor needs a direct editor or admin
// membership and does not inherit a global administrator's session-only access.
async function requireRunCreatorRegistryAccess(
  connection: Connection,
  member: { projectId: string; userId: string },
): Promise<void> {
  const membership = await first(
    connection,
    "SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND role IN ('editor','admin')",
    [member.projectId, member.userId],
  );
  if (!membership)
    throw new DomainError(403, 'Runの作成者にProjectの編集権限がありません', 'project_forbidden');
}
