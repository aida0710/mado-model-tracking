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
// Immutable backend name: 'filesystem' and 's3' from the environment, or one stored in the DB.
export type ArtifactBackend = string;
export type { ExecutionRuntime, ExecutionRuntimeKind } from './executionRuntime.js';
export type { ModelAutomationRule, ModelAutomationExecution } from './modelAutomation.js';
export type { CreateAutomationExecution } from './modelAutomation.js';
export type { ModelAutomationExecutionPage } from './modelAutomation.js';
export type {
  AutomatedRunSummary,
  ModelVersionDetail,
  ModelVersionEvaluationSummary,
  ModelVersionResultRunKind,
  RunDownstreamPage,
} from './modelVersionEvaluations.js';
export { MODEL_VERSION_RESULT_RUN_KINDS } from './modelVersionEvaluations.js';
export type { ExecutionMode, ExecutionSnapshot, ExperimentTask, TaskExecution, TaskRunPage, RepositoryFiles } from './experimentTasks.js';
export type { RunOutputRegistration, TaskOutputModel } from './experimentTasks.js';
export type { AuditActorType, AuditEvent, AuditEventPage, AuditOutcome } from './audit.js';
export type { ModelAliasEvent, ModelAliasEventPage, ModelAliasEventSource } from './modelAliases.js';
export type {
  EvaluationComparison,
  EvaluationComparisonStatus,
  MetricComparison,
  MetricValueSource,
  MetricValueStatus,
} from './evaluation.js';
export { DEFAULT_BASELINE_ALIAS } from './evaluation.js';
export type { ArtifactUpload, ArtifactUploadCreate, ArtifactUploadDetail, ArtifactUploadPart, ArtifactUploadStatus } from './artifactUploads.js';
export type { RunSearchPage, RunSearchRequest } from './runSearch.js';
export type { ArtifactDirectoryEntry, ArtifactListVersions, ArtifactPage, ArtifactTree } from './artifactListing.js';
export type { ArtifactMediaInfo } from './artifactMediaInfo.js';
export { ARTIFACT_MEDIA_INFO_BATCH_LIMIT } from './artifactMediaInfo.js';
export type { ArtifactPreview, ArtifactPreviewKind, ArtifactPreviewStatus, WaveformPeaksPreview } from './artifactPreviews.js';
export { ARTIFACT_PREVIEW_KINDS, BROWSER_AUDIO_ANALYSIS_MAX_BYTES } from './artifactPreviews.js';
import type { DatasetContentKind } from './datasetContent.js';
export type { DatasetContentKind, DatasetVersionContent, DatasetVersionFile, DatasetVersionFileInput, DatasetVersionFilePage } from './datasetContent.js';
export { MAX_DATASET_VERSION_FILES } from './datasetContent.js';
export type { Comment, CommentAuthor, CommentCreate, CommentPage, CommentTargetType, CommentUpdate, RunNote, RunNoteUpdate } from './comments.js';
export { COMMENT_MAX_LENGTH, RUN_NOTE_MAX_LENGTH, RUN_NOTE_TAG } from './comments.js';
export type { ProjectGroupBinding, ProjectMember, ProjectMemberGroupRole, UserSearchResult } from './projectAccess.js';
export type { ServiceAccount, ServiceAccountCreate, ServiceAccountTokenCreate, ServiceAccountUpdate, TokenScope } from './serviceAccounts.js';
export { TOKEN_SCOPE_REQUIRED_ROLE, TOKEN_SCOPES } from './serviceAccounts.js';
export type {
  PromotionCriterion,
  PromotionCriterionDirection,
  PromotionCriterionMode,
  PromotionCriterionOutcome,
  PromotionCriterionReason,
  PromotionCriterionResult,
  PromotionDecision,
  PromotionEvaluation,
  PromotionEvaluationPage,
  PromotionEvaluationReason,
  PromotionMissingBaseline,
  PromotionPolicy,
  PromotionPolicyCreate,
  PromotionPolicyPatch,
} from './promotion.js';
export { PROMOTION_CRITERIA_MAX, PROMOTION_FIRST_RELEASE_REASON } from './promotion.js';
export type { Account, AdminUser, AdminUserCreate, AdminUserPasswordReset, AdminUserPatch, AdminUserQuery, UserKind } from './adminUsers.js';
export type { StorageBackend, StorageBackendChoices, StorageBackendCreate, StorageBackendKind, StorageBackendPatch, StorageBackendSource, StorageSettings, StorageTestResult, StorageTestStep } from './storageBackends.js';
export type { ContainerResultArtifact, ContainerResultDataset, ContainerResultMetric, ContainerResultModel, ContainerResultV2, RunOutputDeclaration, WorkerOutputDeclaration, WorkerOutputsRequest, WorkerOutputsResponse } from './workerOutputs.js';
export type { ChartPanelConfig, ChartPanelLayout, ChartSmoothing, ChartXAxis, RunGroupBy } from './chartPanels.js';
export type {
  MetricGroup,
  MetricGroupPoint,
  MetricGroupsRequest,
  MetricGroupsResponse,
  MetricSeries,
  MetricSeriesPoint,
  MetricSeriesRequest,
  MetricSeriesResponse,
  MetricXRange,
} from './metricSeries.js';
export {
  DEFAULT_SERIES_POINTS,
  MAX_GROUPED_RUNS,
  MAX_SERIES_GROUPS,
  MAX_SERIES_KEYS,
  MAX_SERIES_POINTS,
  MAX_SERIES_RUNS,
  RUN_GROUP_NONE,
} from './metricSeries.js';
export type { RunResumeEvent, RunResumeEventPage, RunResumeRequest, RunResumeResult, RunResumeSource, RunSegment } from './runResume.js';
export { RUN_RESUME_REASON_MAX_LENGTH } from './runResume.js';
export type { ArtifactPresence, ArtifactPresenceCheck, ArtifactPresenceItem, SyncBatch, SyncBatchCounts, SyncBatchResult, SyncBatchStatus, SyncRunCreate, SyncTerminalStatus } from './runSync.js';
export {
  SYNC_ARTIFACT_CHECK_MAX_ITEMS,
  SYNC_BATCH_MAX_LOGS,
  SYNC_BATCH_MAX_METRICS,
  SYNC_CLOCK_SKEW_SECONDS,
  SYNC_ORIGIN_MAX_LENGTH,
} from './runSync.js';
export type {
  NotificationChannel,
  NotificationChannelCreate,
  NotificationChannelKind,
  NotificationChannelPatch,
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationEvent,
  NotificationEventType,
  NotificationRule,
  NotificationRuleCreate,
  NotificationRuleFilter,
  NotificationRulePatch,
  NotificationRunSummary,
  NotificationTestResult,
} from './notifications.js';
export {
  NOTIFICATION_ENV_PREFIX,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_RECIPIENTS_MAX,
} from './notifications.js';
export type {
  Sweep,
  SweepCancel,
  SweepCreate,
  SweepEarlyStopping,
  SweepMethod,
  SweepObjective,
  SweepPage,
  SweepParameterDefinition,
  SweepParameterValue,
  SweepPatch,
  SweepStatus,
  SweepStatusReason,
  SweepTrial,
  SweepTrialCounts,
  SweepTrialPage,
  SweepTrialState,
} from './sweeps.js';
export type {
  ImportanceUnavailableReason,
  ParameterExclusionReason,
  ParameterImportanceEntry,
  ParameterImportanceRequest,
  ParameterImportanceResult,
  RunAnalysisMetric,
  RunAnalysisObjective,
  RunAnalysisParam,
  RunAnalysisParamKind,
  RunAnalysisRange,
  RunAnalysisRow,
  RunAnalysisTableRequest,
  RunAnalysisTableResponse,
  RunSet,
} from './runAnalysis.js';
export { ANALYSIS_MAX_METRICS, ANALYSIS_MAX_PARAMS, ANALYSIS_MAX_RUNS } from './runAnalysis.js';
import type { ExecutionRuntime, ExecutionRuntimeKind } from './executionRuntime.js';
import type { ExecutionMode, ExecutionSnapshot } from './experimentTasks.js';
import type { TaskOutputModel } from './experimentTasks.js';

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
  // 'service' is a Service Account: it has no login method and acts only through its tokens.
  kind: 'human' | 'service';
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
  // Subset of inputDatasetVersionIds produced by an upstream Run; fixed at creation.
  upstreamDatasetVersionIds: string[];
  outputDatasetVersionIds: string[];
  outputModelVersionIds: string[];
  /** Task outputModel copied at launch; registration runs when the Run ends. */
  outputModelRegistration?: TaskOutputModel | null;
  parentRunId: string | null;
  environment: JsonObject;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  // Label of the machine an offline-synced Run came from; null for Runs created online.
  syncOrigin?: string | null;
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
  contentKind: DatasetContentKind;
  /** Files and their total bytes for 'artifacts' versions; null for 'reference' versions. */
  fileCount: number | null;
  totalSize: number | null;
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
  // Derived: claimed/running with no heartbeat for 60 seconds. Display only; status is unchanged.
  heartbeatStale: boolean;
}
export type WorkerPresenceStatus = 'online' | 'offline';
export interface WorkerPresence {
  projectId: string;
  tokenId: string;
  tokenName: string;
  workerId: string;
  version: string | null;
  hostname: string | null;
  targetIds: string[] | null;
  parallelJobs: number | null;
  startedAt: string;
  lastSeenAt: string;
  status: WorkerPresenceStatus;
  activeJobCount: number;
}
export interface WorkerJob {
  job: Job;
  run: Run;
  target: ComputeTarget;
  codeVersion: CodeVersion;
  modelVersion: ModelVersion | null;
  inputDatasets: DatasetVersion[];
  // Token for the Job's code (mmtj_). Set only when this claim/resume issued a new one; null
  // for a running Job, whose process keeps the token the worker saved earlier.
  jobToken: string | null;
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
  ownerType: 'user' | 'service_account';
  ownerId: string;
  ownerName: string;
  // First 12 characters of the token value; null for tokens issued before prefixes were kept.
  tokenPrefix: string | null;
  // kind='service' owned by a person: the form used before Service Accounts. It keeps working.
  legacy: boolean;
}
// GET /auth/token: the authenticating API token itself (`job` is true for Job tokens).
export interface CurrentApiToken {
  id: string;
  projectId: string | null;
  scopes: string[];
  job: boolean;
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
export type { TargetCheck, TargetCheckFailureReason, TargetCheckGpu, TargetCheckItem, TargetCheckItemCode, TargetCheckItemName, TargetCheckItemStatus, TargetCheckResult, TargetCheckStatus, WorkerTargetCheck, WorkerTargetCheckClaim, WorkerTargetCheckComplete } from './targetChecks.js';
