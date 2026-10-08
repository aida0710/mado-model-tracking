import type { JsonObject, Model, ModelVersion } from '@mmt/contracts';

export type LoggedModelStatus = 'PENDING' | 'READY' | 'FAILED';
export interface LoggedModelRecord {
  id: string;
  projectId: string;
  experimentId: string;
  sourceRunId: string | null;
  name: string;
  modelType: string | null;
  status: LoggedModelStatus;
  params: Record<string, string>;
  tags: Record<string, string>;
  metadata: JsonObject;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LoggedModelMetric {
  key: string;
  value: number;
  timestampMs: string;
  step: string;
  modelId: string;
  runId: string;
  datasetName: string | null;
  datasetDigest: string | null;
}

export interface ArtifactManifestEntry {
  path: string;
  artifactId: string;
  sha256: string;
  size: number;
}

export interface RegisteredModelRecord extends Omit<Model, 'latestVersion' | 'aliases'> {
  tags: Record<string, string>;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ModelVersionRecord extends ModelVersion {
  name: string;
  description: string;
  tags: Record<string, string>;
  runLink: string;
  currentStage: string;
  artifactUri: string | null;
  loggedModelId: string | null;
  updatedAt: string;
  aliases: string[];
  deletedAt: string | null;
}

export interface ModelReference {
  name: string;
  version: string;
}

export interface SavedModelArtifacts {
  manifest: ArtifactManifestEntry[];
  artifactUri: string;
  sourceRunId: string | null;
  loggedModelId: string | null;
  metadata: JsonObject;
  tags: Record<string, string>;
}
