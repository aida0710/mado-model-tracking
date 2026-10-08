import type { ComparedDatasetVersion, ComparedModelVersion, Run } from '@mmt/contracts';
import { rows, type Connection } from '../db/database.js';
import { runSummarySelect } from './runListProjection.js';

// JSON keys are written in camelCase because rows() maps only SQL column names.
const comparedModelVersionJson = `jsonb_build_object('id',v.id,'modelId',v.model_id,
  'modelName',m.name,'version',v.version)`;
const comparedDatasetVersionJson = `jsonb_build_object('id',v.id,'datasetId',v.dataset_id,
  'namespace',d.namespace,'name',d.name,'version',v.version,'digest',v.digest)`;

export interface ComparedRun {
  run: Run;
  modelVersion: ComparedModelVersion | null;
  /** Input DatasetVersions in Run.inputDatasetVersionIds order. */
  datasetVersions: ComparedDatasetVersion[];
}

type ComparedRunRow = Run & {
  comparedModelVersion: ComparedModelVersion | null;
  comparedDatasetVersions: ComparedDatasetVersion[];
};

/**
 * Reads the polling summaries of the Runs of one Project together with their ModelVersion and
 * input DatasetVersions in a single statement. Runs of other Projects are simply absent.
 */
export async function readComparedRuns(
  connection: Connection,
  selection: { projectId: string; runIds: string[] },
): Promise<ComparedRun[]> {
  const found = await rows<ComparedRunRow>(
    connection,
    `SELECT s.*,
      (SELECT ${comparedModelVersionJson} FROM model_versions v JOIN models m ON m.id=v.model_id
        WHERE v.id=s.model_version_id) AS compared_model_version,
      (SELECT COALESCE(jsonb_agg(${comparedDatasetVersionJson} ORDER BY u.position),'[]'::jsonb)
        FROM unnest(s.input_dataset_version_ids) WITH ORDINALITY AS u(id,position)
        JOIN dataset_versions v ON v.id=u.id JOIN datasets d ON d.id=v.dataset_id)
        AS compared_dataset_versions
    FROM (${runSummarySelect} WHERE project_id=$1 AND id=ANY($2::uuid[])) s`,
    [selection.projectId, selection.runIds],
  );
  return found.map(({ comparedModelVersion, comparedDatasetVersions, ...run }) => ({
    run,
    modelVersion: comparedModelVersion,
    datasetVersions: comparedDatasetVersions,
  }));
}

/** The same descriptions as readComparedRuns, for Runs read elsewhere (search pages). */
export async function readComparedVersions(
  connection: Connection,
  selection: {
    projectId: string;
    modelVersionIds: string[];
    datasetVersionIds: string[];
  },
): Promise<{
  modelVersions: ComparedModelVersion[];
  datasetVersions: ComparedDatasetVersion[];
}> {
  const [modelVersions, datasetVersions] = await Promise.all([
    rows<{ version: ComparedModelVersion }>(
      connection,
      `SELECT ${comparedModelVersionJson} AS version
      FROM model_versions v JOIN models m ON m.id=v.model_id
      WHERE v.project_id=$1 AND v.id=ANY($2::uuid[])`,
      [selection.projectId, selection.modelVersionIds],
    ),
    rows<{ version: ComparedDatasetVersion }>(
      connection,
      `SELECT ${comparedDatasetVersionJson} AS version
      FROM dataset_versions v JOIN datasets d ON d.id=v.dataset_id
      WHERE v.project_id=$1 AND v.id=ANY($2::uuid[])`,
      [selection.projectId, selection.datasetVersionIds],
    ),
  ]);
  return {
    modelVersions: modelVersions.map((row) => row.version),
    datasetVersions: datasetVersions.map((row) => row.version),
  };
}
