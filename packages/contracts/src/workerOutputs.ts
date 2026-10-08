import type { JsonObject } from './index.js';

/** One file under /mmt/outputs. The worker saves it as the Run Artifact `container/<path>`. */
export interface ContainerResultArtifact {
  path: string;
  sha256: string;
  size: number;
  mimeType?: string;
}

export interface ContainerResultMetric {
  name: string;
  value: number;
  step?: number;
  timestamp?: string;
}

/** A model the container produced; `path` is an output file listed in the result. */
export interface ContainerResultModel {
  path: string;
  /** Omitted when the Task's output model decides the destination. */
  modelId?: string;
  metadata?: JsonObject;
}

/** A dataset version the container produced: either an output file (`path`) or an external `uri`. */
export interface ContainerResultDataset {
  datasetId: string;
  uri?: string;
  path?: string;
  digest: string;
  schema?: JsonObject;
  metadata?: JsonObject;
}

/**
 * /mmt/outputs/result.json version 2. Version 1 has only version, complete, artifacts and metrics.
 * `artifactsManifest` names an output file in JSON Lines, one ContainerResultArtifact per line,
 * for outputs too many to list in result.json; its entries are added to `artifacts`.
 */
export interface ContainerResultV2 {
  version: 2;
  complete: true;
  artifacts?: ContainerResultArtifact[];
  artifactsManifest?: string;
  metrics?: ContainerResultMetric[];
  models?: ContainerResultModel[];
  datasets?: ContainerResultDataset[];
}

/**
 * `index` identifies the declaration within its Run and makes resending safe. The worker numbers
 * result.json's `models` from 0 and continues with `datasets` (models.length + position).
 */
export type WorkerOutputDeclaration =
  | ({ index: number; kind: 'model' } & ContainerResultModel)
  | ({ index: number; kind: 'dataset' } & ContainerResultDataset);

export interface WorkerOutputsRequest {
  leaseId: string;
  declarations: WorkerOutputDeclaration[];
}

/** The version registered for one declaration. A resent index returns the stored row. */
export interface RunOutputDeclaration {
  index: number;
  kind: 'model' | 'dataset';
  modelVersionId: string | null;
  datasetVersionId: string | null;
  createdAt: string;
}

export interface WorkerOutputsResponse {
  items: RunOutputDeclaration[];
}
