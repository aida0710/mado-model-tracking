import type {
  LoggedModelMetric,
  LoggedModelRecord,
  ModelVersionRecord,
  RegisteredModelRecord,
} from './types.js';

export function loggedModelArtifactUri(id: string): string {
  return `mlflow-artifacts:/models/${id}/artifacts`;
}
const statusNames = {
  PENDING: 'LOGGED_MODEL_PENDING',
  READY: 'LOGGED_MODEL_READY',
  FAILED: 'LOGGED_MODEL_UPLOAD_FAILED',
} as const;
const milliseconds = (timestamp: string) => String(Date.parse(timestamp));
export function protocolTags(tags: Record<string, string>) {
  return Object.entries(tags).map(([key, value]) => ({ key, value }));
}

export function loggedModelProtocol(
  model: LoggedModelRecord,
  metrics: LoggedModelMetric[] = [],
  registrations: { name: string; version: string }[] = [],
) {
  return {
    info: {
      model_id: model.id,
      experiment_id: model.experimentId,
      name: model.name,
      creation_timestamp_ms: milliseconds(model.createdAt),
      last_updated_timestamp_ms: milliseconds(model.updatedAt),
      artifact_uri: loggedModelArtifactUri(model.id),
      status: statusNames[model.status],
      ...(model.sourceRunId ? { source_run_id: model.sourceRunId } : {}),
      ...(model.modelType ? { model_type: model.modelType } : {}),
      tags: protocolTags(model.tags),
      registrations,
    },
    data: {
      params: protocolTags(model.params),
      metrics: metrics.map((metric) => ({
        key: metric.key,
        value: Number.isFinite(metric.value) ? metric.value : String(metric.value),
        timestamp: String(metric.timestampMs),
        step: String(metric.step),
        model_id: metric.modelId,
        run_id: metric.runId,
        ...(metric.datasetName ? { dataset_name: metric.datasetName } : {}),
        ...(metric.datasetDigest ? { dataset_digest: metric.datasetDigest } : {}),
      })),
    },
  };
}

export function modelVersionProtocol(version: ModelVersionRecord) {
  return {
    name: version.name,
    version: version.version,
    creation_timestamp: milliseconds(version.createdAt),
    last_updated_timestamp: milliseconds(version.updatedAt),
    current_stage: version.currentStage,
    description: version.description,
    source: version.artifactUri ?? version.weightsUri ?? '',
    run_id: version.sourceRunId ?? '',
    status: 'READY',
    tags: protocolTags(version.tags),
    run_link: version.runLink,
    aliases: version.aliases,
    ...(version.loggedModelId ? { model_id: version.loggedModelId } : {}),
  };
}

export function latestVersions(
  versions: ModelVersionRecord[],
  stages?: string[],
): ModelVersionRecord[] {
  const latest = new Map<string, ModelVersionRecord>();
  for (const version of versions) {
    if (stages && !stages.includes(version.currentStage)) continue;
    const existing = latest.get(version.currentStage);
    if (!existing) {
      latest.set(version.currentStage, version);
      continue;
    }
    const isNewer =
      version.version.match(/^[0-9]+$/) && existing.version.match(/^[0-9]+$/)
        ? BigInt(version.version) > BigInt(existing.version)
        : version.createdAt > existing.createdAt;
    if (isNewer) latest.set(version.currentStage, version);
  }
  return [...latest.values()];
}

export function registeredModelProtocol(
  model: RegisteredModelRecord,
  versions: ModelVersionRecord[],
) {
  return {
    name: model.name,
    creation_timestamp: milliseconds(model.createdAt),
    last_updated_timestamp: milliseconds(model.updatedAt),
    description: model.description,
    tags: protocolTags(model.tags),
    latest_versions: latestVersions(versions).map(modelVersionProtocol),
    aliases: versions.flatMap((version) =>
      version.aliases.map((alias) => ({ alias, version: version.version })),
    ),
  };
}
