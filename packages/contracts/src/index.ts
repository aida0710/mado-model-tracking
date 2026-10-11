export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ProjectRole = 'viewer' | 'editor' | 'admin';
/**
 * public: every active human user may open the Project as an editor without being a member;
 * private: only members (direct grants and group bindings) may open it. The admin role always
 * comes from membership.
 */
export type ProjectVisibility = 'public' | 'private';
export type RunKind = 'inference' | 'evaluation' | 'training' | 'finetuning' | 'processing';
export type RunStatus = 'queued' | 'running' | 'finished' | 'failed' | 'canceled';
export type JobStatus = RunStatus | 'claimed';
// Immutable backend name: 'filesystem' and 's3' from the environment, or one stored in the DB.
export type ArtifactBackend = string;
export type { ExecutionRuntime, ExecutionRuntimeKind } from './executionRuntime.js';
export type { ModelAutomationRule, ModelAutomationExecution } from './modelAutomation.js';
export type { CreateAutomationExecution } from './modelAutomation.js';
export type { AutomationRuleOwnerTransfer } from './modelAutomation.js';
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
export type { ModelAliasAssignment, ModelAliasProtection, ModelAliasProtectionInput, ModelAliasProtectionRole } from './modelAliases.js';
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
export type { ArtifactBackendUsage, ArtifactUsage } from './artifactUsage.js';
export type { ArtifactMediaInfo } from './artifactMediaInfo.js';
export { ARTIFACT_MEDIA_INFO_BATCH_LIMIT } from './artifactMediaInfo.js';
export type { ArtifactPreview, ArtifactPreviewKind, ArtifactPreviewStatus, WaveformPeaksPreview } from './artifactPreviews.js';
export { ARTIFACT_PREVIEW_KINDS, BROWSER_AUDIO_ANALYSIS_MAX_BYTES } from './artifactPreviews.js';
import type { DatasetContentKind } from './datasetContent.js';
import type { DatasetTransferMode } from './targetDatasetCache.js';
export type { DatasetTransferMode } from './targetDatasetCache.js';
export { DATASET_TRANSFER_MODES, DEFAULT_DATASET_CACHE_MAX_BYTES, MIN_DATASET_CACHE_MAX_BYTES } from './targetDatasetCache.js';
export type { DatasetContentKind, DatasetVersionContent, DatasetVersionFile, DatasetVersionFileInput, DatasetVersionFilePage } from './datasetContent.js';
export { MAX_DATASET_VERSION_FILES } from './datasetContent.js';
export type { Comment, CommentAuthor, CommentCreate, CommentPage, CommentTargetType, CommentUpdate, RunNote, RunNoteUpdate } from './comments.js';
export { COMMENT_MAX_LENGTH, RUN_NOTE_MAX_LENGTH, RUN_NOTE_TAG } from './comments.js';
export type { ProjectGroupBinding, ProjectMember, ProjectMemberGroupRole, UserSearchResult } from './projectAccess.js';
export type { AdminProject, AdminProjectQuery, ProjectCreate, ProjectMemberGrant, ProjectPatch } from './projectAdministration.js';
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
export type { PromotionPolicyOwnerTransfer } from './promotion.js';
export { PROMOTION_CRITERIA_MAX, PROMOTION_FIRST_RELEASE_REASON } from './promotion.js';
export type { Account, AdminUser, AdminUserCreate, AdminUserPasswordReset, AdminUserPatch, AdminUserQuery, UserKind } from './adminUsers.js';
export type { DirectorySuggestions, StorageBackend, StorageBackendChoices, StorageBackendCreate, StorageBackendKind, StorageBackendPatch, StorageBackendSource, StorageSettings, StorageTestResult, StorageTestStep } from './storageBackends.js';
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
  JobRetryRequest,
  RunCheckpoint,
  RunCheckpointArtifact,
  RunCheckpointCreate,
  RunCheckpointFile,
  RunCheckpointManifest,
  RunCheckpointPage,
  RunCheckpointSource,
  RunResumeCheckpointRecord,
  WorkerResumeCheckpoint,
} from './checkpoints.js';
export { DEFAULT_CHECKPOINT_KEEP_COUNT, MLFLOW_CHECKPOINT_PATH_PREFIX } from './checkpoints.js';
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
export type { ComparedDatasetVersion, ComparedModelVersion, RunComparison, RunComparisonNamespace, RunComparisonRequest, RunComparisonRow, RunComparisonValue } from './runComparison.js';
export { RUN_COMPARISON_MAX_METRIC_KEYS, RUN_COMPARISON_MAX_RUNS, RUN_COMPARISON_MIN_RUNS, RUN_EXPORT_TRUNCATED_HEADER } from './runComparison.js';
export type {
  CpuArch,
  JobArrayCreate,
  JobArrayCreated,
  JobArrayGroup,
  JobEndReason,
  JobPhase,
  ManualSubmissionClaim,
  ManualSubmissionReport,
  ManualSubmissionWaiting,
  RunnerFinish,
  RunnerFinishResult,
  RunnerHeartbeat,
  RunnerLogs,
  RunnerMetrics,
  RunnerOutputs,
  RunnerPhase,
  RunnerStart,
  RunnerState,
  SiteSchedulerCancellation,
  SiteSchedulerCancellationReport,
  SiteSubmission,
  SiteSubmissionClaim,
  SiteSubmissionMode,
  SiteSubmissionReport,
  SiteSubmissionRequester,
  SiteSubmissionResult,
} from './siteExecution.js';
export {
  CPU_ARCHES,
  JOB_END_REASONS,
  JOB_PHASES,
  MAX_JOB_ARRAY_SIZE,
  MAX_JOB_GPU_COUNT,
  MAX_JOB_WALLTIME_SECONDS,
  SITE_CLAIM_MAX_SUBMISSIONS,
  MAX_QUEUE_TIMEOUT_SECONDS,
  MIN_QUEUE_TIMEOUT_SECONDS,
  SITE_SUBMISSION_MODES,
  SITE_SUBMISSION_REPORT_TIMEOUT_SECONDS,
} from './siteExecution.js';
export type {
  ComputeTargetDetails,
  ComputeTargetSharing,
  ComputeTargetSiteFields,
  Launcher,
  LauncherConfiguration,
  LauncherConnectionCheck,
  LauncherConnectionCheckResult,
  LauncherCreate,
  LauncherCreated,
  LauncherKey,
  LauncherKeyPublish,
  LauncherSite,
  ManualSiteConfiguration,
  ShareableProject,
  SiteAccountMode,
  SiteConnection,
  SiteConnectionCheck,
  SiteConnectionCheckRequest,
  SiteConnectionCheckStatus,
  SiteGpuAssignment,
  SiteJobShell,
  SiteJobShellCreate,
  SiteJobShellSummary,
  SiteKey,
  SiteKeyRotate,
  SiteKeyStatus,
  SitePersonalSettings,
  SitePersonalSettingsInput,
  SitePersonalSettingsLookup,
  SiteSettings,
  SiteSettingsInput,
  SiteSubmissionAccount,
} from './siteComputers.js';
export {
  DEFAULT_SITE_CANCEL_GRACE_SECONDS,
  DEFAULT_SITE_MAX_ACTIVE_SUBMISSIONS,
  DEFAULT_SITE_MAX_OUTPUT_FILES,
  DEFAULT_SITE_RUNNER_PYTHON,
  DEFAULT_SITE_SSH_PORT,
  MAX_JOB_SHELL_BYTES,
  MAX_KNOWN_HOSTS_BYTES,
  MAX_SITE_ACCOUNT_NAME_LENGTH,
  MAX_SITE_CANCEL_COMMAND_LENGTH,
  MAX_SITE_CANCEL_GRACE_SECONDS,
  MAX_SITE_HOST_LENGTH,
  MAX_SITE_JUMP_HOST_LENGTH,
  MAX_SITE_JUMP_HOSTS,
  MAX_SITE_MAX_OUTPUT_FILES,
  MAX_SITE_PATH_LENGTH,
  MAX_SITE_VARIABLE_NAME_LENGTH,
  MAX_SITE_VARIABLE_VALUE_LENGTH,
  MAX_SITE_VARIABLES,
  SITE_ACCOUNT_MODES,
  SITE_ACCOUNT_NAME_PATTERN,
  SITE_CONNECTION_CHECK_STATUSES,
  SITE_CONNECTION_CHECK_TIMEOUT_SECONDS,
  SITE_GPU_ASSIGNMENTS,
  SITE_HOST_PATTERN,
  SITE_JUMP_HOST_PATTERN,
  SITE_KEY_STATUSES,
  SITE_PATH_PATTERN,
  SITE_RUNNER_PYTHON_PATTERN,
  SITE_VARIABLE_NAME_PATTERN,
} from './siteComputers.js';
export type {
  ChildJobCreate,
  ChildJobCreated,
  ChildJobWait,
  Hook,
  HookCheckpointMode,
  HookConcurrency,
  HookCreate,
  HookCreated,
  HookExecution,
  HookExecutionPage,
  HookExecutionStatus,
  HookExecutionSubject,
  HookFilter,
  HookJobTemplate,
  HookJobTemplateInput,
  HookOwnerTransfer,
  HookSkipReason,
  HookToggle,
  HookTrigger,
  HookTriggerRequest,
  HookWebhookSignature,
  JobStatusCounts,
} from './hooks.js';
export {
  CHILD_JOB_WAIT_MAX_SECONDS,
  DEFAULT_HOOK_MAX_STARTS_PER_HOUR,
  HOOK_CHECKPOINT_MODES,
  HOOK_CONCURRENCY_MODES,
  HOOK_FILTER_FIELDS,
  HOOK_PAYLOAD_MAX_BYTES,
  HOOK_PENDING_MAX_AGE_HOURS,
  HOOK_SKIP_REASONS,
  HOOK_TRIGGERS,
  HOOK_WEBHOOK_SIGNATURES,
  HOOK_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  MAX_ACTIVE_CHILD_JOBS,
  MAX_CHILD_JOBS_PER_PARENT,
  MAX_HOOK_CHECKPOINT_EVERY,
  MAX_HOOK_MAX_STARTS_PER_HOUR,
  MAX_JOB_CHAIN_DEPTH,
  hookWebhookPath,
} from './hooks.js';
import type { CpuArch, JobEndReason, JobPhase, SiteSubmissionMode } from './siteExecution.js';
import type { ExecutionRuntime, ExecutionRuntimeKind } from './executionRuntime.js';
import type { ExecutionMode, ExecutionSnapshot } from './experimentTasks.js';
import type { TaskOutputModel } from './experimentTasks.js';
import type { WorkerResumeCheckpoint } from './checkpoints.js';
import type { UserKind } from './adminUsers.js';

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
  // 'launcher' is a launcher's user, which owns only the launcher's token.
  kind: UserKind;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  artifactBackend: ArtifactBackend;
  visibility: ProjectVisibility;
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
  // The checkpoint this Run continues from; fixed at creation (environment.resume mirrors it).
  resumeCheckpointId?: string | null;
  environment: JsonObject;
  createdBy: string;
  /** Display name of createdBy, for screens; null if the user record is gone. */
  createdByName?: string | null;
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
  // Set while archived: new Runs refuse its versions as inputs; existing Runs keep them.
  archivedAt: string | null;
  createdAt: string;
}
// PATCH bodies of the registry lifecycle; at least one field is required.
export interface ModelUpdate {
  description?: string;
}
export interface ExperimentUpdate {
  // Unique within the Project.
  name?: string;
  description?: string;
}
export interface DatasetUpdate {
  archived?: boolean;
  description?: string;
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
  /** Set once the Artifact is deleted; deleted Artifacts are not listed and their content is 404. */
  deletedAt?: string | null;
}
/**
 * ssh and local targets are driven by the worker over SSH. A site is only described here: its
 * launcher (or `mado-tracking submit`) and job shell hold the connection and scheduler settings,
 * so a site's host, username, key paths, work directory and Python are empty strings.
 */
export type ComputeTargetExecutor = 'ssh' | 'local' | 'site';
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
  executor: ComputeTargetExecutor;
  /** Upper bound of the target's dataset cache (<workDirectory>/.mmt-cache/datasets). */
  datasetCacheMaxBytes: number;
  datasetTransfer: DatasetTransferMode;
  /** Sites: 'manual' when the requester submits with `mado-tracking submit` (logins with OTP). */
  submissionMode: SiteSubmissionMode;
  /** CPU of the compute nodes; images and SIFs must be built for it. */
  cpuArch: CpuArch;
  /** Sites: the job shell submits an array in one call (MMT_ARRAY_SIZE). */
  supportsArray: boolean;
  /** Sites: a Job still in the scheduler queue after this many seconds fails as queue_timeout. */
  queueTimeoutSeconds: number | null;
  /** null: managed by global administrators; otherwise the researcher who added the site. */
  ownerUserId: string | null;
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
  // Site Jobs that wait for submission or in a scheduler queue send no heartbeat and are not stale.
  heartbeatStale: boolean;
  /** Site Jobs only: where the Job is between queued and its end. */
  phase: JobPhase | null;
  /** GPUs requested; for ssh/local Jobs the number of gpuIds. */
  gpuCount: number;
  walltimeSeconds: number | null;
  schedulerJobId: string | null;
  submittedAt: string | null;
  runnerHost: string | null;
  arrayGroupId: string | null;
  arrayIndex: number | null;
  arraySize: number | null;
  endReason: JobEndReason | null;
  /** The driver Job that created this one with its Job token. */
  parentJobId: string | null;
  /** Links from the first manual start through hooks and drivers to this Job. */
  chainDepth: number;
  hookId: string | null;
  allowChildJobs: boolean;
  retryOnFailure: boolean;
  retryOnTimeout: boolean;
  datasetPartitionVersionId: string | null;
  /** Site Jobs: the job shell version they were submitted with, once claimed. */
  siteJobShellId: string | null;
}
/**
 * A row of GET /projects/:p/jobs: the Job with the names of its Run and Task, so the list reads
 * without opening each Run. sweepEarlyStopped tells a Sweep's early stop (Run tag
 * mmt.sweepEarlyStopped) from a cancel by a person; both end as canceled.
 */
export interface JobListItem extends Job {
  runName: string;
  runKind: RunKind;
  taskId: string | null;
  taskName: string | null;
  sweepEarlyStopped: boolean;
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
  // Set when the Run continues from a checkpoint; the worker verifies it before the entrypoint.
  resumeCheckpoint?: WorkerResumeCheckpoint | null;
  // A checkpoint handed to the code as an input (checkpoint_saved hooks); not a resume.
  inputCheckpoint?: WorkerResumeCheckpoint | null;
  // The webhook body or manual trigger payload of the hook start; trigger-payload.json in the Job.
  triggerPayload?: JsonObject | null;
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
export type {
  SavedView,
  SavedViewColumn,
  SavedViewCreate,
  SavedViewPage,
  SavedViewPatch,
  SavedViewState,
  SavedViewVisibility,
} from './savedViews.js';
export {
  SAVED_VIEW_MAX_COLUMNS,
  SAVED_VIEW_NAME_MAX_LENGTH,
  SAVED_VIEW_STATE_MAX_BYTES,
} from './savedViews.js';
export type {
  OperationsAlert,
  OperationsAlertKind,
  OperationsAlertResolution,
  OperationsAlertState,
  PluginOutboxSummary,
} from './operations.js';
export { OPERATIONS_ALERT_KINDS } from './operations.js';
export type {
  MediaCompareGrid,
  MediaCompareRequest,
  MediaCompareRow,
  MediaTableCell,
  MediaTableColumn,
  MediaTableColumnType,
  MediaTableMediaCell,
  MediaTablePage,
  MediaTableReferenceError,
  RunMedia,
  RunMediaCreate,
  RunMediaCreateItem,
  RunMediaKeySummary,
  RunMediaKind,
  RunMediaList,
  RunMediaPage,
  RunMediaSource,
} from './runMedia.js';
export {
  MEDIA_COMPARE_MAX_RUNS,
  MEDIA_COMPARE_MAX_STEPS,
  MEDIA_TABLE_MAX_BYTES,
  MEDIA_TABLE_PAGE_MAX_ROWS,
  MLFLOW_LOGGED_ARTIFACTS_TAG,
  RUN_MEDIA_CAPTION_MAX_LENGTH,
  RUN_MEDIA_CREATE_MAX_ITEMS,
  RUN_MEDIA_KEY_MAX_LENGTH,
  RUN_MEDIA_METADATA_MAX_BYTES,
} from './runMedia.js';
export type {
  Report,
  ReportBlock,
  ReportBlockSnapshot,
  ReportBlockType,
  ReportChartBlock,
  ReportCreate,
  ReportDetail,
  ReportEmbedBlock,
  ReportEmbedMode,
  ReportMarkdownBlock,
  ReportMediaBlock,
  ReportMediaTableBlock,
  ReportPage,
  ReportParallelCoordinatesBlock,
  ReportParameterImportanceBlock,
  ReportRestore,
  ReportRevision,
  ReportRevisionSummary,
  ReportRunSet,
  ReportRunTableBlock,
  ReportScatterBlock,
  ReportSnapshotData,
  ReportSnapshotList,
  ReportSnapshotRun,
  ReportUpdate,
  ReportUser,
} from './reports.js';
export {
  REPORT_BLOCKS_MAX_BYTES,
  REPORT_MARKDOWN_MAX_LENGTH,
  REPORT_MAX_BLOCKS,
  REPORT_MESSAGE_MAX_LENGTH,
  REPORT_RUN_SET_MAX_RUN_IDS,
  REPORT_RUN_TABLE_MAX_COLUMNS,
  REPORT_RUN_TABLE_MAX_ROWS,
  REPORT_SNAPSHOT_BLOCK_MAX_BYTES,
  REPORT_TITLE_MAX_LENGTH,
} from './reports.js';
