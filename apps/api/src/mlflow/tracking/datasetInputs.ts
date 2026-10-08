import { createHash } from 'node:crypto';
import type { JsonObject, Run } from '@mmt/contracts';
import type { Principal } from '../../auth/principal.js';
import { first, type Connection } from '../../db/database.js';
import type { RegistryService } from '../../services/registryService.js';
import { enqueueRunEvent } from '../../services/outboxEvents.js';
import { requireScope } from '../../services/accessService.js';
import { isTerminalStatus } from '../../domain/runTransitions.js';
import type { TrackingDataset, TrackingDatasetInput } from './trackingTypes.js';
import { invalidParameter } from './trackingValidation.js';
import { runColumns } from '../../repositories/runListProjection.js';

// Dataset identity locks use a namespace separate from schema migration and parent Run locks.
const DATASET_REGISTRATION_LOCK_NAMESPACE = 4183;

function datasetIdentity(dataset: TrackingDataset): string {
  return createHash('sha256')
    .update(JSON.stringify([dataset.name, dataset.digest, dataset.source_type, dataset.source]))
    .digest('hex');
}
function datasetUri(dataset: TrackingDataset, identity: string): string {
  try {
    const source = JSON.parse(dataset.source) as Record<string, unknown>;
    const uri = source.uri ?? source.path;
    if (typeof uri === 'string') return uri;
  } catch {
    /* The source field is opaque in the protocol and is retained without fetching it. */
  }
  return `mlflow-dataset:/${identity}`;
}
function nativeSchema(dataset: TrackingDataset): JsonObject {
  if (!dataset.schema) return {};
  try {
    const schema: unknown = JSON.parse(dataset.schema);
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) return schema as JsonObject;
  } catch {
    /* Some dataset sources provide a schema string rather than a JSON object. */
  }
  return { mlflowSchema: dataset.schema };
}

async function registerDataset(
  connection: Connection,
  registry: RegistryService,
  request: { principal: Principal; projectId: string; dataset: TrackingDataset },
): Promise<string> {
  const { projectId, dataset } = request;
  const identity = datasetIdentity(dataset);
  // Concurrent runs must resolve the same native immutable version before linking their inputs.
  await connection.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [
    DATASET_REGISTRATION_LOCK_NAMESPACE,
    `${projectId}:${identity}`,
  ]);
  const saved = await first<{ datasetVersionId: string; dataset: TrackingDataset }>(
    connection,
    'SELECT * FROM mlflow_datasets WHERE project_id=$1 AND identity=$2',
    [projectId, identity],
  );
  if (saved) {
    for (const key of ['schema', 'profile'] as const)
      if (saved.dataset[key] !== dataset[key])
        invalidParameter('既存Datasetとschema/profileが一致しません');
    return saved.datasetVersionId;
  }
  requireScope(request.principal, 'registry:write');
  const nativeDataset =
    (await first<{ id: string }>(
      connection,
      `INSERT INTO datasets(project_id,namespace,name) VALUES($1,'mlflow',$2)
    ON CONFLICT(project_id,namespace,name) DO NOTHING RETURNING id`,
      [projectId, dataset.name],
    )) ??
    (await first<{ id: string }>(
      connection,
      "SELECT id FROM datasets WHERE project_id=$1 AND namespace='mlflow' AND name=$2",
      [projectId, dataset.name],
    ))!;
  const version = await registry.insertDatasetVersion(connection, projectId, {
    datasetId: nativeDataset.id,
    input: {
      version: identity,
      uri: datasetUri(dataset, identity),
      digest: dataset.digest,
      schema: nativeSchema(dataset),
      metadata: { mlflow: { ...dataset } },
      parentDatasetVersionIds: [],
    },
  });
  await connection.query(
    'INSERT INTO mlflow_datasets(project_id,identity,dataset_version_id,dataset) VALUES($1,$2,$3,$4::jsonb)',
    [projectId, identity, version.id, JSON.stringify(dataset)],
  );
  return version.id;
}

export async function logDatasetInputs(
  connection: Connection,
  registry: RegistryService,
  request: { principal: Principal; run: Run; datasets: TrackingDatasetInput[] },
): Promise<void> {
  // Stable ordering avoids deadlocks when two runs log the same group of datasets in reverse order.
  const inputs = [...request.datasets].sort(
    (left, right) =>
      left.dataset.name.localeCompare(right.dataset.name) ||
      datasetIdentity(left.dataset).localeCompare(datasetIdentity(right.dataset)),
  );
  const versionIds = new Set(request.run.inputDatasetVersionIds);
  for (const input of inputs) {
    const versionId = await registerDataset(connection, registry, {
      principal: request.principal,
      projectId: request.run.projectId,
      dataset: input.dataset,
    });
    const tags = Object.fromEntries(input.tags.map(({ key, value }) => [key, value]));
    const context = tags['mlflow.data.context'] ?? '';
    await connection.query(
      `INSERT INTO mlflow_run_dataset_inputs(project_id,run_id,dataset_version_id,context,tags) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(project_id,run_id,dataset_version_id,context) DO UPDATE SET tags=mlflow_run_dataset_inputs.tags||EXCLUDED.tags`,
      [request.run.projectId, request.run.id, versionId, context, JSON.stringify(tags)],
    );
    versionIds.add(versionId);
  }
  const updated = (await first<Run>(
    connection,
    `UPDATE runs SET input_dataset_version_ids=$2::uuid[] WHERE id=$1 RETURNING ${runColumns}`,
    [request.run.id, [...versionIds]],
  ))!;
  if (
    isTerminalStatus(updated.status) &&
    versionIds.size !== request.run.inputDatasetVersionIds.length
  )
    await enqueueRunEvent(connection, updated);
}
