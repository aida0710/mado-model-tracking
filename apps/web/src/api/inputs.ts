import type {
  ArtifactBackend,
  CodeSource,
  ComputeTarget,
  DatasetVersionContent,
  ExecutionRuntime,
  ExecutionMode,
  ExperimentTask,
  JsonObject,
  ModelAutomationRule,
  PluginDataset,
  RunKind,
  RunStatus,
} from '@mmt/contracts';

export interface CreateProject {
  name: string;
  description?: string;
  artifactBackend?: ArtifactBackend;
}
export interface CreateRun {
  experimentId: string;
  name: string;
  kind: RunKind;
  executionMode?: ExecutionMode;
  parameters?: JsonObject;
  tags?: Record<string, string>;
  modelVersionId?: string;
  codeVersionId?: string;
  inputDatasetVersionIds?: string[];
  parentRunId?: string;
  environment?: JsonObject;
}
export interface CreateModelVersion {
  version: string;
  parentModelVersionIds?: string[];
  sourceRunId?: string;
  weightsUri?: string;
  artifactId?: string;
  defaultCodeVersionId?: string;
  metadata?: JsonObject;
}
export interface CreateCodeVersion {
  version: string;
  source: CodeSource | null;
  runtime: ExecutionRuntime;
  entrypoint: string[];
  testEntrypoint?: string[];
  requirements?: string[];
  environment?: Record<string, string>;
  supportedModelFamilies: string[];
  taskTypes: RunKind[];
}
// summaryMetrics defaults to [] on the server; the rule form does not set it yet.
export type CreateAutomationRule = Omit<
  ModelAutomationRule,
  | 'id'
  | 'projectId'
  | 'createdBy'
  | 'createdAt'
  | 'summaryMetrics'
  | 'runAsUserId'
  | 'runAsKind'
  | 'runAsName'
> & { summaryMetrics?: string[] };
/** Without content: a reference version (version, uri, digest). With content: the server sets uri and digest. */
export interface CreateDatasetVersion {
  version?: string;
  uri?: string;
  digest?: string;
  schema?: JsonObject;
  metadata?: JsonObject;
  sourceRunId?: string;
  parentDatasetVersionIds?: string[];
  content?: DatasetVersionContent;
}
export interface CreateToken {
  name: string;
  kind: 'personal' | 'service';
  projectId: string;
  scopes: string[];
  expiresAt?: string;
}
export type CreateTarget = Omit<ComputeTarget, 'id'>;
export type CreateTask = Omit<ExperimentTask, 'id' | 'projectId' | 'revision' | 'createdAt' | 'updatedAt'>;
export type UpdateTask = Partial<Omit<CreateTask, 'experimentId'>> & { expectedRevision: number };
export interface LaunchTask {
  expectedRevision: number;
  executionMode: ExecutionMode;
  targetId?: string;
  gpuIds?: string[];
  name?: string;
  parameters?: JsonObject;
  modelVersionId?: string | null;
  inputDatasetVersionIds?: string[];
  /** Starts the new Run from this checkpoint; the API checks it matches the Task's code. */
  resumeCheckpointId?: string;
}
export interface UpdateRun {
  name?: string;
  tags?: Record<string, string>;
  status?: RunStatus;
  environment?: JsonObject;
}
export interface ImportPluginDataset {
  dataset: PluginDataset;
}
