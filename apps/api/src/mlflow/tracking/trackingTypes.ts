import type { Experiment, Run, RunStatus } from '@mmt/contracts';

export type LifecycleStage = 'active' | 'deleted';
export type MlflowRunStatus = 'RUNNING' | 'SCHEDULED' | 'FINISHED' | 'FAILED' | 'KILLED';
export interface TrackingExperiment extends Experiment {
  lifecycleStage: LifecycleStage;
  tags: Record<string, string>;
  artifactLocation: string | null;
  updatedAt: string;
}
export interface TrackingRun extends Run {
  lifecycleStage: LifecycleStage;
  mlflowManaged: boolean;
  mlflowUserId: string | null;
  recordedParameters: Run['parameters'];
}
export interface KeyValue {
  key: string;
  value: string;
}
export interface TrackingMetric {
  key: string;
  value: number | 'NaN' | 'Infinity' | '-Infinity';
  timestamp: number;
  step: number | string;
  model_id?: string;
  dataset_name?: string;
  dataset_digest?: string;
  run_id?: string;
}
export interface MetricRow {
  name: string;
  value: number;
  step: number | string;
  timestamp: string;
  mlflowModelId: string | null;
  mlflowDatasetName: string | null;
  mlflowDatasetDigest: string | null;
}
export interface RunRelatedRecords {
  metrics: MetricRow[];
  datasets: { dataset: TrackingDataset; tags: Record<string, string> }[];
  modelInputs: { modelId: string }[];
  modelOutputs: { modelId: string; step: number | string }[];
}
export interface TrackingDataset {
  name: string;
  digest: string;
  source_type: string;
  source: string;
  schema?: string;
  profile?: string;
}
export interface TrackingDatasetInput {
  dataset: TrackingDataset;
  tags: KeyValue[];
}
export interface TrackingBatch {
  metrics: TrackingMetric[];
  params: KeyValue[];
  tags: KeyValue[];
}
export interface TrackingSearch {
  max_results: number;
  page_token?: string;
  filter: string;
  order_by: string[];
}
export interface SearchPage<T> {
  items: T[];
  next_page_token?: string;
}

export const nativeRunStatus: Record<MlflowRunStatus, RunStatus> = {
  RUNNING: 'running',
  SCHEDULED: 'queued',
  FINISHED: 'finished',
  FAILED: 'failed',
  KILLED: 'canceled',
};
export const mlflowRunStatus: Record<RunStatus, MlflowRunStatus> = {
  running: 'RUNNING',
  queued: 'SCHEDULED',
  finished: 'FINISHED',
  failed: 'FAILED',
  canceled: 'KILLED',
};
