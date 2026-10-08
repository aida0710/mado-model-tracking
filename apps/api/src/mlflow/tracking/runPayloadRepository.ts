import { rows, type Connection } from '../../db/database.js';
import type {
  MetricRow,
  RunRelatedRecords,
  TrackingDataset,
  TrackingRun,
} from './trackingTypes.js';

export const metricColumns =
  'name,value,step,timestamp,mlflow_model_id,mlflow_dataset_name,mlflow_dataset_digest';

function groupByRun<T extends { runId: string }>(records: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const group = grouped.get(record.runId) ?? [];
    group.push(record);
    grouped.set(record.runId, group);
  }
  return grouped;
}

export async function loadRunRecords(
  connection: Connection,
  runs: TrackingRun[],
): Promise<Map<string, RunRelatedRecords>> {
  if (!runs.length) return new Map();
  const runIds = runs.map((run) => run.id);
  const projectId = runs[0]!.projectId;
  // A page uses four bounded queries instead of querying each Run separately.
  const metrics = await rows<MetricRow & { runId: string }>(
    connection,
    `SELECT DISTINCT ON(run_id,name) run_id,${metricColumns} FROM metrics WHERE run_id=ANY($1::uuid[])
      ORDER BY run_id,name,step DESC,timestamp DESC,value DESC,id DESC`,
    [runIds],
  );
  const datasets = await rows<{
    runId: string;
    dataset: TrackingDataset;
    tags: Record<string, string>;
  }>(
    connection,
    `SELECT i.run_id,d.dataset,i.tags FROM mlflow_run_dataset_inputs i JOIN mlflow_datasets d
      ON d.project_id=i.project_id AND d.dataset_version_id=i.dataset_version_id
      WHERE i.project_id=$1 AND i.run_id=ANY($2::uuid[]) ORDER BY i.dataset_version_id,i.context`,
    [projectId, runIds],
  );
  const modelInputs = await rows<{ runId: string; modelId: string }>(
    connection,
    'SELECT run_id,model_id FROM mlflow_run_model_inputs WHERE project_id=$1 AND run_id=ANY($2::uuid[]) ORDER BY model_id',
    [projectId, runIds],
  );
  const modelOutputs = await rows<{ runId: string; modelId: string; step: number | string }>(
    connection,
    'SELECT run_id,model_id,step FROM mlflow_run_model_outputs WHERE project_id=$1 AND run_id=ANY($2::uuid[]) ORDER BY model_id,step',
    [projectId, runIds],
  );
  const metricsByRun = groupByRun(metrics);
  const datasetsByRun = groupByRun(datasets);
  const modelInputsByRun = groupByRun(modelInputs);
  const modelOutputsByRun = groupByRun(modelOutputs);
  return new Map(
    runs.map((run) => [
      run.id,
      {
        metrics: metricsByRun.get(run.id) ?? [],
        datasets: datasetsByRun.get(run.id) ?? [],
        modelInputs: modelInputsByRun.get(run.id) ?? [],
        modelOutputs: modelOutputsByRun.get(run.id) ?? [],
      },
    ]),
  );
}
