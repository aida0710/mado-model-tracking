import { randomUUID } from 'node:crypto';
import type { Dataset, DatasetVersion, ExternalDatasetRef, JsonObject, Run } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { datasetManifestDigest } from '../domain/datasetManifestDigest.js';
import { conflict, DomainError, notFound } from '../domain/errors.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import {
  assertProjectReference,
  assertProjectReferences,
  findRun,
} from '../repositories/registryRepository.js';
import { runColumns } from '../repositories/runListProjection.js';
import { requireProject } from './accessService.js';
import type { ModelVersionRegistrationActor } from './modelVersionRegistration.js';
import { enqueueRunEvent } from './outboxEvents.js';

// Dataset versions are registered by the same two kinds of actor as model versions, plus callers
// that already checked the principal with their own rule (plugin imports need Project admin,
// MLflow log_inputs checks scopes per dataset).
export type DatasetVersionRegistrationActor =
  | ModelVersionRegistrationActor
  | { type: 'callerAuthorized' };

/** A file of an 'artifacts' version, with the Artifact's size and sha256 already looked up. */
export interface DatasetManifestFile {
  path: string;
  artifactId: string;
  size: number;
  sha256: string;
}

interface DatasetVersionRegistrationBase {
  projectId: string;
  datasetId: string;
  // Omitted versions take the next integer after the dataset's integer versions.
  version?: string;
  schema: JsonObject;
  metadata: JsonObject;
  sourceRunId?: string | null;
  parentDatasetVersionIds: string[];
  actor: DatasetVersionRegistrationActor;
}

/** Data stored elsewhere: the client's uri and digest are kept as given. */
interface ReferenceContentRegistration {
  uri: string;
  digest: string;
  externalRef?: ExternalDatasetRef | null;
  content?: undefined;
}

/**
 * The version is these Artifacts. The server sets uri to `mmt-dataset://<versionId>` and computes
 * the manifest digest; a digest the client sent must equal it.
 */
interface ArtifactContentRegistration {
  content: { files: DatasetManifestFile[] };
  digest?: string;
  uri?: undefined;
  externalRef?: undefined;
}

export type DatasetVersionRegistration = DatasetVersionRegistrationBase &
  (ReferenceContentRegistration | ArtifactContentRegistration);

// Resolved by the API itself (GET .../versions/:v/files); W5 workers fetch the files through it.
const DATASET_VERSION_URI_SCHEME = 'mmt-dataset://';

// Non-integer versions ("2026-10", "v1") stay as they are and do not take part in numbering.
// 18 digits keeps the value inside bigint.
const INTEGER_VERSION_PATTERN = '^[1-9][0-9]{0,17}$';

/**
 * Inserts an immutable DatasetVersion, and for Artifact content its file list, in the caller's
 * transaction and lists it in the source Run's outputs. A registration that arrives after the Run
 * ended resends the Run's outbox event so external lineage sees the new output.
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
  if (registration.externalRef) {
    const reference = registration.externalRef;
    await assertProjectReference(connection, {
      table: 'plugin_connections',
      projectId,
      id: reference.pluginId,
    });
    if (
      reference.version !== registration.version ||
      reference.name !== dataset.name ||
      reference.namespace !== dataset.namespace
    )
      conflict('External datasetの参照が登録する版と一致しません');
  }
  const stored = describeStoredContent(registration);
  const version = registration.version ?? (await nextDatasetVersion(connection, dataset.id));
  const inserted = (await first<Omit<DatasetVersion, 'name' | 'namespace'>>(
    connection,
    `INSERT INTO dataset_versions(id,dataset_id,project_id,version,uri,digest,schema,metadata,source_run_id,parent_dataset_version_ids,external_ref,content_kind,file_count,total_size)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      stored.id,
      dataset.id,
      projectId,
      version,
      stored.uri,
      stored.digest,
      JSON.stringify(registration.schema),
      JSON.stringify(registration.metadata),
      sourceRun?.id ?? null,
      registration.parentDatasetVersionIds,
      registration.externalRef ? JSON.stringify(registration.externalRef) : null,
      stored.contentKind,
      stored.fileCount,
      stored.totalSize,
    ],
  ))!;
  if (registration.content)
    await insertDatasetVersionFiles(connection, {
      projectId,
      datasetVersionId: inserted.id,
      files: registration.content.files,
    });
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

interface StoredDatasetContent {
  id: string;
  uri: string;
  digest: string;
  contentKind: DatasetVersion['contentKind'];
  fileCount: number | null;
  totalSize: number | null;
}

function describeStoredContent(registration: DatasetVersionRegistration): StoredDatasetContent {
  // The id is chosen here because the immutable row must carry its own uri from the INSERT.
  const id = randomUUID();
  if (!registration.content)
    return {
      id,
      uri: registration.uri,
      digest: registration.digest,
      contentKind: 'reference',
      fileCount: null,
      totalSize: null,
    };
  const { files } = registration.content;
  const digest = datasetManifestDigest(files);
  if (registration.digest !== undefined && registration.digest !== digest)
    throw new DomainError(
      422,
      `digestがファイル一覧から計算した値（${digest}）と一致しません`,
      'dataset_digest_mismatch',
    );
  return {
    id,
    uri: `${DATASET_VERSION_URI_SCHEME}${id}`,
    digest,
    contentKind: 'artifacts',
    fileCount: files.length,
    totalSize: files.reduce((total, file) => total + file.size, 0),
  };
}

// One statement with array parameters inserts up to MAX_DATASET_VERSION_FILES rows.
async function insertDatasetVersionFiles(
  connection: Connection,
  manifest: { projectId: string; datasetVersionId: string; files: DatasetManifestFile[] },
): Promise<void> {
  const { files } = manifest;
  await connection.query(
    `INSERT INTO dataset_version_files(dataset_version_id,project_id,path,artifact_id,size,sha256)
    SELECT $1,$2,file.path,file.artifact_id,file.size,file.sha256
    FROM unnest($3::text[],$4::uuid[],$5::bigint[],$6::text[]) AS file(path,artifact_id,size,sha256)`,
    [
      manifest.datasetVersionId,
      manifest.projectId,
      files.map((file) => file.path),
      files.map((file) => file.artifactId),
      files.map((file) => file.size),
      files.map((file) => file.sha256),
    ],
  );
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
