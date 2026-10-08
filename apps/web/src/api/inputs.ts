import type {
  ArtifactBackend,
  CodeSource,
  ComputeTarget,
  ExecutionRuntime,
  ExecutionMode,
  ExperimentTask,
  JsonObject,
  ModelAutomationRule,
  PluginDataset,
  ProjectRole,
  RunKind,
  RunStatus,
  User,
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
export type CreateAutomationRule = Omit<
  ModelAutomationRule,
  'id' | 'projectId' | 'createdBy' | 'createdAt'
>;
export interface CreateDatasetVersion {
  version: string;
  uri: string;
  digest: string;
  schema?: JsonObject;
  metadata?: JsonObject;
  sourceRunId?: string;
  parentDatasetVersionIds?: string[];
}
export interface ProjectMember {
  user: User;
  role: ProjectRole;
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
