import type { Connection } from '../../db/database.js';
import { first, rows } from '../../db/database.js';
import { notFound } from '../../domain/errors.js';
import type {
  LoggedModelRecord,
  LoggedModelMetric,
  ModelVersionRecord,
  RegisteredModelRecord,
} from './types.js';

export const registeredModelSelect = `SELECT m.*,COALESCE(mm.tags,'{}'::jsonb) AS tags,
  COALESCE(mm.updated_at,m.created_at) AS updated_at,mm.deleted_at
  FROM models m LEFT JOIN mlflow_registered_model_metadata mm ON mm.model_id=m.id`;

export const modelVersionSelect = `SELECT v.*,m.name,m.family,
  COALESCE(vm.tags,'{}'::jsonb) AS tags,COALESCE(vm.description,'') AS description,
  COALESCE(vm.current_stage,'None') AS current_stage,COALESCE(vm.run_link,'') AS run_link,
  COALESCE(vm.updated_at,v.created_at) AS updated_at,vm.deleted_at,vm.logged_model_id,vm.artifact_uri,
  ARRAY(SELECT a.alias FROM model_aliases a WHERE a.version_id=v.id ORDER BY a.alias) AS aliases
  FROM model_versions v JOIN models m ON m.id=v.model_id
  LEFT JOIN mlflow_model_version_metadata vm ON vm.version_id=v.id
  LEFT JOIN mlflow_registered_model_metadata mm ON mm.model_id=m.id`;

export async function findLoggedModel(
  connection: Connection,
  reference: { projectId: string; id: string; lock?: boolean; allowDeleted?: boolean },
): Promise<LoggedModelRecord> {
  if (reference.lock) {
    // Lock the Experiment before the model so lifecycle deletion cannot race finalization.
    const experiment = await first<{ sourceRunId: string | null }>(
      connection,
      `SELECT l.source_run_id FROM experiments e JOIN mlflow_logged_models l ON l.experiment_id=e.id AND l.project_id=e.project_id
      WHERE l.project_id=$1 AND l.id=$2 AND e.lifecycle_stage='active' FOR SHARE OF e`,
      [reference.projectId, reference.id],
    );
    if (!experiment) notFound('LoggedModel');
    if (experiment.sourceRunId) {
      // Match Tracking and Artifact's source Run -> model order before native INSERT takes
      // its source Run FK lock. Taking a Run lock after the model can deadlock with outputs.
      await connection.query('SELECT id FROM runs WHERE project_id=$1 AND id=$2 FOR KEY SHARE', [
        reference.projectId,
        experiment.sourceRunId,
      ]);
    }
  }
  const model = await first<LoggedModelRecord>(
    connection,
    `SELECT l.* FROM mlflow_logged_models l JOIN experiments e ON e.id=l.experiment_id AND e.project_id=l.project_id
      WHERE l.project_id=$1 AND l.id=$2 ${reference.allowDeleted ? '' : "AND l.deleted_at IS NULL AND e.lifecycle_stage='active'"} ${reference.lock ? 'FOR UPDATE OF l' : ''}`,
    [reference.projectId, reference.id],
  );
  if (!model) notFound('LoggedModel');
  return model;
}

export async function findRegisteredModel(
  connection: Connection,
  reference: { projectId: string; name: string; lock?: boolean },
): Promise<RegisteredModelRecord> {
  const model = await first<RegisteredModelRecord>(
    connection,
    `${registeredModelSelect} WHERE m.project_id=$1 AND m.name=$2 AND mm.deleted_at IS NULL ${reference.lock ? 'FOR UPDATE OF m' : ''}`,
    [reference.projectId, reference.name],
  );
  if (!model) notFound('RegisteredModel');
  return model;
}

export async function findModelVersion(
  connection: Connection,
  reference: { projectId: string; name: string; version: string },
): Promise<ModelVersionRecord> {
  const version = await first<ModelVersionRecord>(
    connection,
    `${modelVersionSelect} WHERE v.project_id=$1 AND m.name=$2 AND v.version=$3 AND vm.deleted_at IS NULL AND mm.deleted_at IS NULL`,
    [reference.projectId, reference.name, reference.version],
  );
  if (!version) notFound('ModelVersion');
  return version;
}

export async function loggedModelMetrics(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<LoggedModelMetric[]> {
  return rows(
    connection,
    `SELECT key,value,timestamp_ms,step,model_id,run_id,dataset_name,dataset_digest
    FROM mlflow_logged_model_metrics WHERE project_id=$1 AND model_id=$2
    ORDER BY key,run_id,COALESCE(dataset_name,''),COALESCE(dataset_digest,''),timestamp_ms,step,id`,
    [reference.projectId, reference.id],
  );
}

export async function activeModelVersions(
  connection: Connection,
  model: { projectId: string; id: string },
): Promise<ModelVersionRecord[]> {
  const versionsByModel = await activeModelVersionsByModel(connection, {
    projectId: model.projectId,
    modelIds: [model.id],
  });
  return versionsByModel.get(model.id) ?? [];
}

// Loads every listed Model's versions in one query so list responses do not issue one per Model.
export async function activeModelVersionsByModel(
  connection: Connection,
  models: { projectId: string; modelIds: string[] },
): Promise<Map<string, ModelVersionRecord[]>> {
  const versionsByModel = new Map<string, ModelVersionRecord[]>();
  if (!models.modelIds.length) return versionsByModel;
  const versions = await rows<ModelVersionRecord>(
    connection,
    `${modelVersionSelect} WHERE v.project_id=$1 AND v.model_id=ANY($2::uuid[]) AND vm.deleted_at IS NULL AND mm.deleted_at IS NULL ORDER BY v.created_at DESC,v.id DESC`,
    [models.projectId, models.modelIds],
  );
  for (const version of versions) {
    const modelVersions = versionsByModel.get(version.modelId);
    if (modelVersions) modelVersions.push(version);
    else versionsByModel.set(version.modelId, [version]);
  }
  return versionsByModel;
}
