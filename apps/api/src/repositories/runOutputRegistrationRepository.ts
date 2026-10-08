import type { Model, RunOutputRegistration, TaskOutputModel } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';

export interface OutputRegistrationSource {
  id: string;
  name: string;
  modelVersionId: string | null;
  taskRevision: number | null;
  outputModelRegistration: TaskOutputModel | null;
}

export type OutputModel = Pick<Model, 'id' | 'family'> & { deleted: boolean };

const registrationColumns = 'status,model_version_id,error,reason';

export async function findRunOutputRegistration(
  connection: Connection,
  reference: { projectId: string; runId: string },
): Promise<RunOutputRegistration | undefined> {
  return first<RunOutputRegistration>(
    connection,
    `SELECT ${registrationColumns} FROM run_output_registrations WHERE project_id=$1 AND run_id=$2`,
    [reference.projectId, reference.runId],
  );
}

export async function insertRunOutputRegistration(
  connection: Connection,
  record: { projectId: string; runId: string; outcome: RunOutputRegistration },
): Promise<void> {
  const { outcome } = record;
  await connection.query(
    `INSERT INTO run_output_registrations(run_id,project_id,status,model_version_id,error,reason)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [
      record.runId,
      record.projectId,
      outcome.status,
      outcome.modelVersionId,
      outcome.error,
      outcome.reason,
    ],
  );
}

export async function findOutputRegistrationSource(
  connection: Connection,
  reference: { projectId: string; runId: string },
): Promise<OutputRegistrationSource | undefined> {
  return first<OutputRegistrationSource>(
    connection,
    `SELECT id,name,model_version_id,task_revision,output_model_registration
    FROM runs WHERE project_id=$1 AND id=$2`,
    [reference.projectId, reference.runId],
  );
}

// MLflow soft-deleted registered models keep their row; registering into them would revive a
// Model the user removed, so they are reported instead of used.
const outputModelSelect = `SELECT m.id,m.family,(mm.deleted_at IS NOT NULL) AS deleted
  FROM models m LEFT JOIN mlflow_registered_model_metadata mm ON mm.model_id=m.id`;

export async function findOutputModelById(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<OutputModel | undefined> {
  return first<OutputModel>(connection, `${outputModelSelect} WHERE m.project_id=$1 AND m.id=$2`, [
    reference.projectId,
    reference.id,
  ]);
}

export async function findOutputModelByName(
  connection: Connection,
  reference: { projectId: string; name: string },
): Promise<OutputModel | undefined> {
  return first<OutputModel>(
    connection,
    `${outputModelSelect} WHERE m.project_id=$1 AND m.name=$2`,
    [reference.projectId, reference.name],
  );
}

// Same reuse rule as the SDK's model_name=: an existing Model with the name is used as is, and a
// concurrent creation of the same name resolves to the row that won.
export async function findOrCreateOutputModel(
  connection: Connection,
  request: { projectId: string; name: string; family: string },
): Promise<OutputModel> {
  await connection.query(
    `INSERT INTO models(project_id,name,family,description) VALUES($1,$2,$3,'')
    ON CONFLICT (project_id,name) DO NOTHING`,
    [request.projectId, request.name, request.family],
  );
  return (await findOutputModelByName(connection, request))!;
}

// A version the Run registered itself (SDK register_output_model or MLflow
// log_model(registered_model_name=…)) makes the Task-side registration redundant.
export async function findVersionRegisteredByRun(
  connection: Connection,
  reference: { projectId: string; runId: string; modelId: string },
): Promise<string | undefined> {
  const version = await first<{ id: string }>(
    connection,
    `SELECT v.id FROM model_versions v
    LEFT JOIN mlflow_model_version_metadata vm ON vm.version_id=v.id
    WHERE v.project_id=$1 AND v.source_run_id=$2 AND v.model_id=$3 AND vm.deleted_at IS NULL
    ORDER BY v.created_at,v.id LIMIT 1`,
    [reference.projectId, reference.runId, reference.modelId],
  );
  return version?.id;
}

// Worker outputs and MLflow log_artifact can upload the same path again; the last upload wins.
export async function findLatestRunArtifact(
  connection: Connection,
  reference: { projectId: string; runId: string; path: string },
): Promise<string | undefined> {
  const artifact = await first<{ id: string }>(
    connection,
    `SELECT id FROM artifacts WHERE project_id=$1 AND run_id=$2 AND path=$3 AND deleted_at IS NULL
    ORDER BY created_at DESC,id DESC LIMIT 1`,
    [reference.projectId, reference.runId, reference.path],
  );
  return artifact?.id;
}
