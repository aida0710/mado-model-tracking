import type { CodeVersion, DatasetVersion, ModelVersion, Run } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import { notFound } from '../domain/errors.js';

export const modelSelect = `SELECT m.*, (SELECT version FROM model_versions v WHERE v.model_id=m.id ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_version,
  (SELECT COALESCE(jsonb_object_agg(alias,version_id::text),'{}'::jsonb) FROM model_aliases WHERE model_id=m.id) AS aliases FROM models m`;
export const codeSelect = `SELECT c.*, (SELECT version FROM code_versions v WHERE v.code_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_version FROM codes c`;
export const datasetSelect = `SELECT d.*, (SELECT version FROM dataset_versions v WHERE v.dataset_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_version FROM datasets d`;
export const modelVersionSelect =
  'SELECT v.*,m.family FROM model_versions v JOIN models m ON m.id=v.model_id';
export const datasetVersionSelect =
  'SELECT v.*,d.name,d.namespace FROM dataset_versions v JOIN datasets d ON d.id=v.dataset_id';

type ReferenceTable =
  | 'experiments'
  | 'runs'
  | 'models'
  | 'codes'
  | 'datasets'
  | 'model_versions'
  | 'code_versions'
  | 'dataset_versions'
  | 'artifacts'
  | 'plugin_connections';

export async function assertProjectReference(
  connection: Connection,
  reference: { table: ReferenceTable; projectId: string; id: string },
): Promise<void> {
  const entity = await first(
    connection,
    `SELECT id FROM ${reference.table} WHERE id=$1 AND project_id=$2`,
    [reference.id, reference.projectId],
  );
  if (!entity) notFound(reference.table);
}

export async function assertProjectReferences(
  connection: Connection,
  reference: { table: ReferenceTable; projectId: string; ids: string[] },
): Promise<void> {
  if (!reference.ids.length) return;
  const entities = await rows<{ id: string }>(
    connection,
    `SELECT id FROM ${reference.table} WHERE project_id=$1 AND id=ANY($2::uuid[])`,
    [reference.projectId, reference.ids],
  );
  if (new Set(entities.map((entity) => entity.id)).size !== new Set(reference.ids).size)
    notFound(reference.table);
}

export async function findCodeVersion(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<CodeVersion> {
  const version = await first<CodeVersion>(
    connection,
    'SELECT * FROM code_versions WHERE project_id=$1 AND id=$2',
    [reference.projectId, reference.id],
  );
  if (!version) notFound('CodeVersion');
  return version;
}

export async function findModelVersion(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<ModelVersion> {
  const version = await first<ModelVersion>(
    connection,
    `${modelVersionSelect} WHERE v.project_id=$1 AND v.id=$2`,
    [reference.projectId, reference.id],
  );
  if (!version) notFound('ModelVersion');
  return version;
}

export async function findDatasetVersions(
  connection: Connection,
  reference: { projectId: string; ids: string[] },
): Promise<DatasetVersion[]> {
  const versions = await rows<DatasetVersion>(
    connection,
    `${datasetVersionSelect} WHERE v.project_id=$1 AND v.id=ANY($2::uuid[])`,
    [reference.projectId, reference.ids],
  );
  if (versions.length !== new Set(reference.ids).size) notFound('DatasetVersion');
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  return reference.ids.map((id) => versionsById.get(id)!);
}

export async function findRun(
  connection: Connection,
  reference: { projectId: string; id: string; lock?: boolean },
): Promise<Run> {
  const run = await first<Run>(
    connection,
    `SELECT * FROM runs WHERE project_id=$1 AND id=$2 ${reference.lock ? 'FOR UPDATE' : ''}`,
    [reference.projectId, reference.id],
  );
  if (!run) notFound('Run');
  return run;
}
