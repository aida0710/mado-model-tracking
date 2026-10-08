export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ProjectRole = 'viewer' | 'editor' | 'admin';
export type RunKind = 'inference' | 'evaluation' | 'training' | 'finetuning' | 'processing';
export type RunStatus = 'queued' | 'running' | 'finished' | 'failed' | 'canceled';
export type JobStatus = RunStatus | 'claimed';
export type ArtifactBackend = 'filesystem' | 's3';
export type { ExecutionRuntime, ExecutionRuntimeKind } from './executionRuntime.js';
export type { ModelAutomationRule, ModelAutomationExecution } from './modelAutomation.js';
export type { ExecutionMode, ExecutionSnapshot, ExperimentTask, TaskExecution, TaskRunPage, RepositoryFiles } from './experimentTasks.js';
export type { AuditActorType, AuditEvent, AuditEventPage, AuditOutcome } from './audit.js';
export type { Comment, CommentAuthor, CommentCreate, CommentPage, CommentTargetType, CommentUpdate, RunNote, RunNoteUpdate } from './comments.js';
export { COMMENT_MAX_LENGTH, RUN_NOTE_MAX_LENGTH, RUN_NOTE_TAG } from './comments.js';
import type { ExecutionRuntime, ExecutionRuntimeKind } from './executionRuntime.js';
import type { ExecutionMode, ExecutionSnapshot } from './experimentTasks.js';

export type AuthMode = 'local' | 'oidc' | 'hybrid' | 'development';
export type AuthSource = 'local' | 'oidc';
export interface User {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  username: string | null;
  status: 'active' | 'disabled';
  authSources: AuthSource[];
}
export interface Project {
  id: string;
  name: string;
  description: string;
  artifactBackend: ArtifactBackend;
  role: ProjectRole;
  createdAt: string;
}
export interface Experiment {
  id: string;
  projectId: string;
  name: string;
  description: string;
  runCount: number;
  createdAt: string;
}
export interface MetricPoint {
  name: string;
  value: number;
  step: number;
  timestamp: string;
}
export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}
export interface Run {
  id: string;
  projectId: string;
  experimentId: string;
  name: string;
  kind: RunKind;
  status: RunStatus;
  parameters: JsonObject;
  recordedParameters?: JsonObject;
  tags: Record<string, string>;
  latestMetrics: Record<string, number>;
  modelVersionId: string | null;
  codeVersionId: string | null;
  taskId?: string | null;
  taskRevision?: number | null;
  executionMode?: ExecutionMode;
  executionSnapshot?: ExecutionSnapshot | null;
  inputDatasetVersionIds: string[];
  outputDatasetVersionIds: string[];
  outputModelVersionIds: string[];
  parentRunId: string | null;
  environment: JsonObject;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}
export interface Model {
  id: string;
  projectId: string;
  name: string;
  family: string;
  description: string;
  latestVersion: string | null;
  aliases: Record<string, string>;
  createdAt: string;
}
export interface ModelVersion {
  id: string;
  modelId: string;
  projectId: string;
  version: string;
  family: string;
  sourceRunId: string | null;
  parentModelVersionIds: string[];
  weightsUri: string | null;
  artifactId: string | null;
  defaultCodeVersionId: string | null;
  metadata: JsonObject;
  createdAt: string;
}
export interface ModelVersionCreate {
  // Omitted versions are numbered by the API with the next MLflow-style integer.
  version?: string;
  parentModelVersionIds?: string[];
  sourceRunId?: string | null;
  weightsUri?: string | null;
  artifactId?: string | null;
  defaultCodeVersionId?: string | null;
  metadata?: JsonObject;
}
export type CodeSource =
  | { kind: 'git'; url: string; commit: string; files?: Record<string, string>; deletedFiles?: string[] }
  | { kind: 'inline'; files: Record<string, string> }
  | { kind: 'artifact'; artifactId: string };
export interface Code {
  id: string;
  projectId: string;
  name: string;
  description: string;
  latestVersion: string | null;
  createdAt: string;
}
export interface CodeVersion {
  id: string;
  codeId: string;
  projectId: string;
  version: string;
  source: CodeSource | null;
  runtime: ExecutionRuntime;
  entrypoint: string[];
  testEntrypoint?: string[];
  requirements: string[];
  environment: Record<string, string>;
  supportedModelFamilies: string[];
  taskTypes: RunKind[];
  createdAt: string;
}
export interface ExternalDatasetRef {
  pluginId: string;
  externalId: string;
  namespace: string;
  name: string;
  version: string;
}
export interface Dataset {
  id: string;
  projectId: string;
  name: string;
  namespace: string;
  description: string;
  latestVersion: string | null;
  createdAt: string;
}
export interface DatasetVersion {
  id: string;
  datasetId: string;
  projectId: string;
  name: string;
  namespace: string;
  version: string;
  uri: string;
  digest: string;
  schema: JsonObject;
  metadata: JsonObject;
  sourceRunId: string | null;
  parentDatasetVersionIds: string[];
  externalRef: ExternalDatasetRef | null;
  createdAt: string;
}
export interface Artifact {
  id: string;
  projectId: string;
  runId: string | null;
  path: string;
  backend: ArtifactBackend;
  storageKey: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
}
export interface ComputeTarget {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  sshKeyPath: string;
  knownHostsPath: string;
  workDirectory: string;
  pythonExecutable: string;
  runtimeKinds: ExecutionRuntimeKind[];
  gpuIds: string[];
  maxConcurrentJobs: number;
  enabled: boolean;
  executor: 'ssh' | 'local';
}
export interface Job {
  id: string;
  projectId: string;
  runId: string;
  targetId: string;
  status: JobStatus;
  gpuIds: string[];
  workerId: string | null;
  leaseId: string | null;
  cancelRequested: boolean;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  heartbeatAt: string | null;
  exitCode: number | null;
  error: string | null;
}
export interface WorkerJob {
  job: Job;
  run: Run;
  target: ComputeTarget;
  codeVersion: CodeVersion;
  modelVersion: ModelVersion | null;
  inputDatasets: DatasetVersion[];
}
export interface TokenSummary {
  id: string;
  name: string;
  kind: 'personal' | 'service';
  projectId: string | null;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  protocolVersion: '1.0';
  capabilities: string[];
}
export interface PluginConnection {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  tokenEnv: string;
  enabled: boolean;
  manifest: PluginManifest | null;
  createdAt: string;
}
export interface PluginDataset {
  externalId: string;
  namespace: string;
  name: string;
  version: string;
  uri: string;
  digest: string;
  schema: JsonObject;
  metadata: JsonObject;
}
export interface PluginEvent {
  id: string;
  type: 'run.started' | 'run.finished' | 'run.failed' | 'run.canceled';
  timestamp: string;
  projectId: string;
  run: Run;
  inputDatasets: DatasetVersion[];
  outputDatasets: DatasetVersion[];
}
export interface LineageNode {
  id: string;
  kind: 'datasetVersion' | 'modelVersion' | 'loggedModel' | 'run' | 'codeVersion';
  label: string;
  status?: string;
  sourceRunId?: string;
}
export interface LineageEdge {
  source: string;
  target: string;
  relation: string;
}
export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}
export interface AuthConfig {
  mode: AuthMode;
  methods: {
    local: boolean;
    oidc: { label: string; loginUrl: string } | null;
  };
}
export interface AuthMe {
  user: User;
  mustChangePassword: boolean;
}
export interface ApiError {
  error: string;
  code?: string;
  issues?: unknown;
}
