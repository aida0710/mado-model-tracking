import type { Connection } from '../../db/database.js';
import { parameterString } from './trackingParameters.js';
import { serializeInt64 } from './trackingNumbers.js';
import { loadRunRecords } from './runPayloadRepository.js';
import {
  mlflowRunStatus,
  type MetricRow,
  type RunRelatedRecords,
  type TrackingExperiment,
  type TrackingRun,
  type TrackingMetric,
} from './trackingTypes.js';

export function serializeExperiment(experiment: TrackingExperiment) {
  return {
    experiment_id: experiment.id,
    name: experiment.name,
    artifact_location:
      experiment.artifactLocation ?? `mlflow-artifacts:/experiments/${experiment.id}`,
    lifecycle_stage: experiment.lifecycleStage,
    creation_time: Date.parse(experiment.createdAt),
    last_update_time: Date.parse(experiment.updatedAt),
    tags: Object.entries(experiment.tags).map(([key, value]) => ({ key, value })),
  };
}
export function serializeRunInfo(run: TrackingRun) {
  return {
    run_id: run.id,
    run_uuid: run.id,
    run_name: run.name,
    experiment_id: run.experimentId,
    user_id: run.mlflowUserId ?? run.createdBy,
    status: mlflowRunStatus[run.status],
    start_time: Date.parse(run.startedAt ?? run.createdAt),
    ...(run.endedAt ? { end_time: Date.parse(run.endedAt) } : {}),
    artifact_uri: `mlflow-artifacts:/runs/${run.id}/artifacts`,
    lifecycle_stage: run.lifecycleStage,
  };
}
export function serializeMetric(point: MetricRow): TrackingMetric {
  return {
    key: point.name,
    value: Number.isFinite(point.value)
      ? point.value
      : (String(point.value) as TrackingMetric['value']),
    timestamp: Date.parse(point.timestamp),
    step: serializeInt64(point.step),
    ...(point.mlflowModelId ? { model_id: point.mlflowModelId } : {}),
    ...(point.mlflowDatasetName ? { dataset_name: point.mlflowDatasetName } : {}),
    ...(point.mlflowDatasetDigest ? { dataset_digest: point.mlflowDatasetDigest } : {}),
  };
}

function serializeRunRecords(run: TrackingRun, records: RunRelatedRecords) {
  const tags = { ...run.tags };
  if (!run.mlflowManaged) {
    tags['mlflow.runName'] ??= run.name;
    if (run.parentRunId) tags['mlflow.parentRunId'] ??= run.parentRunId;
  }
  return {
    info: serializeRunInfo(run),
    data: {
      params: Object.entries({ ...run.parameters, ...run.recordedParameters }).map(
        ([key, value]) => ({ key, value: parameterString(value) }),
      ),
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      metrics: records.metrics.map(serializeMetric),
    },
    inputs: {
      model_inputs: records.modelInputs.map(({ modelId }) => ({ model_id: modelId })),
      dataset_inputs: records.datasets.map(({ dataset, tags }) => ({
        dataset,
        tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      })),
    },
    outputs: {
      model_outputs: records.modelOutputs.map(({ modelId, step }) => ({
        model_id: modelId,
        step: serializeInt64(step),
      })),
    },
  };
}
export async function serializeRuns(connection: Connection, runs: TrackingRun[]) {
  const relatedRecords = await loadRunRecords(connection, runs);
  return runs.map((run) => serializeRunRecords(run, relatedRecords.get(run.id)!));
}
export async function serializeRun(connection: Connection, run: TrackingRun) {
  return (await serializeRuns(connection, [run]))[0]!;
}
