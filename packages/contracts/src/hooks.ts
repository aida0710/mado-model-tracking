import type { Job, JobStatus, JsonObject, RunKind } from './index.js';
import type { UserKind } from './adminUsers.js';

/**
 * Hooks start a Job when something happens in a Project (docs/hooks.md). They generalize the
 * model automation rules: any trigger, any target, and the Job runs as the hook's owner.
 */
export type HookTrigger =
  | 'manual'
  | 'model_registered'
  | 'run_finished'
  | 'array_finished'
  | 'checkpoint_saved'
  | 'webhook';
export const HOOK_TRIGGERS: readonly HookTrigger[] = [
  'manual',
  'model_registered',
  'run_finished',
  'array_finished',
  'checkpoint_saved',
  'webhook',
];

/**
 * Which saved checkpoints of one Run start the hook: every one, every k-th, only the newest while
 * an earlier one is still evaluated (latest), or none while one runs (skip_if_running).
 */
export type HookCheckpointMode = 'every' | 'every_k' | 'latest' | 'skip_if_running';
export const HOOK_CHECKPOINT_MODES: readonly HookCheckpointMode[] = [
  'every',
  'every_k',
  'latest',
  'skip_if_running',
];

/** k of checkpointMode 'every_k'; also the database bound of hooks.checkpoint_every. */
export const MAX_HOOK_CHECKPOINT_EVERY = 100000;

/** queue: start every event; skip_if_running: skip while a Job of the hook has not ended. */
export type HookConcurrency = 'queue' | 'skip_if_running';
export const HOOK_CONCURRENCY_MODES: readonly HookConcurrency[] = ['queue', 'skip_if_running'];

/** github: X-Hub-Signature-256 and X-GitHub-Delivery; mmt: X-MMT-Signature and X-MMT-Delivery. */
export type HookWebhookSignature = 'github' | 'mmt';
export const HOOK_WEBHOOK_SIGNATURES: readonly HookWebhookSignature[] = ['github', 'mmt'];

/** Links along one chain of hooks and driver Jobs; deeper starts are skipped (chain_too_deep). */
export const MAX_JOB_CHAIN_DEPTH = 10;
export const DEFAULT_HOOK_MAX_STARTS_PER_HOUR = 60;
export const MAX_HOOK_MAX_STARTS_PER_HOUR = 10000;
/** A webhook body or a manual trigger payload; it reaches the Job as trigger-payload.json. */
export const HOOK_PAYLOAD_MAX_BYTES = 256 * 1024;
/** A version whose training Run has not ended waits this long before it is skipped. */
export const HOOK_PENDING_MAX_AGE_HOURS = 7 * 24;
/** The mmt signature's timestamp may differ from the server clock by this much. */
export const HOOK_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** Events outside the filter do not start the hook and leave no execution. */
export interface HookFilter {
  modelFamilies?: string[];
  experimentIds?: string[];
  runKinds?: RunKind[];
  runStatuses?: ('finished' | 'failed' | 'canceled')[];
  tags?: Record<string, string>;
}

/**
 * The conditions each trigger's event can be filtered on; a hook with another condition is
 * refused at creation, since it could never match. A model registration is described by its
 * training Run (no end status yet), a checkpoint by the Run that is still training, an array by
 * its first member and the status of all members; manual and webhook starts are not filtered.
 */
export const HOOK_FILTER_FIELDS: Readonly<Record<HookTrigger, readonly (keyof HookFilter)[]>> = {
  manual: [],
  webhook: [],
  model_registered: ['modelFamilies', 'experimentIds', 'runKinds', 'tags'],
  run_finished: ['modelFamilies', 'experimentIds', 'runKinds', 'runStatuses', 'tags'],
  array_finished: ['modelFamilies', 'experimentIds', 'runKinds', 'runStatuses', 'tags'],
  checkpoint_saved: ['modelFamilies', 'experimentIds', 'runKinds', 'tags'],
};

/** Where a webhook hook receives deliveries (unauthenticated POST, checked by its signature). */
export function hookWebhookPath(hookId: string): string {
  return `/api/hooks/${encodeURIComponent(hookId)}/webhook`;
}

/** What one start creates. ssh/local targets take gpuIds; sites take gpuCount. */
export interface HookJobTemplate {
  experimentId: string;
  kind: RunKind;
  codeVersionId: string;
  /** A fixed version; model_registered uses the registered version instead. */
  modelVersionId: string | null;
  /** Take the triggering Run's model version (run_finished, checkpoint_saved). */
  inheritModelVersion: boolean;
  inputDatasetVersionIds: string[];
  /** Add the triggering Run's output DatasetVersions as inputs (marked as upstream outputs). */
  inheritOutputDatasets: boolean;
  parameters: JsonObject;
  tags: Record<string, string>;
  targetId: string;
  gpuIds: string[];
  gpuCount: number;
  walltimeSeconds: number | null;
  /** null starts one Job; a number starts an array of that size (sites only). */
  arraySize: number | null;
  datasetPartitionVersionId: string | null;
  maxAttempts: number;
  retryOnFailure: boolean;
  retryOnTimeout: boolean;
  allowChildJobs: boolean;
}

export type HookJobTemplateInput = Partial<
  Omit<HookJobTemplate, 'experimentId' | 'kind' | 'codeVersionId' | 'targetId'>
> &
  Pick<HookJobTemplate, 'experimentId' | 'kind' | 'codeVersionId' | 'targetId'>;

export interface Hook {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  trigger: HookTrigger;
  filter: HookFilter;
  template: HookJobTemplate;
  checkpointMode: HookCheckpointMode;
  /** k of every_k; null otherwise. */
  checkpointEvery: number | null;
  concurrency: HookConcurrency;
  maxStartsPerHour: number;
  webhookSignature: HookWebhookSignature | null;
  createdBy: string;
  runAsUserId: string;
  runAsKind?: UserKind;
  runAsName?: string;
  createdByName?: string;
  createdAt: string;
}

export interface HookCreate {
  name: string;
  trigger: HookTrigger;
  filter?: HookFilter;
  template: HookJobTemplateInput;
  checkpointMode?: HookCheckpointMode;
  checkpointEvery?: number | null;
  concurrency?: HookConcurrency;
  maxStartsPerHour?: number;
  /** Required for trigger 'webhook'. */
  webhookSignature?: HookWebhookSignature;
}

/** The webhook secret is shown once, at creation; the server keeps it encrypted. */
export interface HookCreated {
  hook: Hook;
  webhookSecret: string | null;
  webhookPath: string | null;
}

export interface HookToggle {
  enabled: boolean;
}

/**
 * PUT /projects/:p/hooks/:id/owner (Project admins): the hook runs as this Service Account from
 * now on, so it keeps starting after its creator leaves. It must be an active editor or admin.
 */
export interface HookOwnerTransfer {
  serviceAccountId: string;
}

/** POST /projects/:p/hooks/:id/trigger (trigger 'manual'); a resend with the key finds the start. */
export interface HookTriggerRequest {
  payload?: JsonObject;
  idempotencyKey?: string;
}

export type HookExecutionStatus = 'pending' | 'queued' | 'skipped' | 'failed';
export type HookExecutionSubject =
  | 'manual'
  | 'model_version'
  | 'run'
  | 'array_group'
  | 'checkpoint'
  | 'webhook';
export type HookSkipReason =
  | 'loop_detected'
  | 'chain_too_deep'
  | 'rate_limited'
  | 'already_running'
  | 'owner_access_revoked'
  | 'superseded'
  | 'source_run_unsuccessful'
  | 'source_run_timeout'
  | 'hook_disabled';
export const HOOK_SKIP_REASONS: readonly HookSkipReason[] = [
  'loop_detected',
  'chain_too_deep',
  'rate_limited',
  'already_running',
  'owner_access_revoked',
  'superseded',
  'source_run_unsuccessful',
  'source_run_timeout',
  'hook_disabled',
];

export interface HookExecution {
  id: string;
  projectId: string;
  hookId: string;
  status: HookExecutionStatus;
  subjectKind: HookExecutionSubject;
  subjectId: string | null;
  reason: HookSkipReason | null;
  error: string | null;
  jobId: string | null;
  arrayGroupId: string | null;
  runId: string | null;
  /** The Run a pending execution waits for. */
  waitingRunId: string | null;
  checkpointId: string | null;
  requestedBy: string | null;
  jobStatus: JobStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface HookExecutionPage {
  items: HookExecution[];
  nextCursor: string | null;
}

/** Driver Jobs: POST /projects/:p/jobs/:j/children with the Job token of :j. */
export const MAX_CHILD_JOBS_PER_PARENT = 10000;
export const MAX_ACTIVE_CHILD_JOBS = 2000;
export const CHILD_JOB_WAIT_MAX_SECONDS = 60;

export interface ChildJobCreate {
  /** A resend with the same key returns the Jobs it created (also after the driver restarts). */
  idempotencyKey: string;
  experimentId?: string;
  name: string;
  kind: RunKind;
  codeVersionId: string;
  modelVersionId?: string | null;
  inputDatasetVersionIds?: string[];
  parameters?: JsonObject;
  tags?: Record<string, string>;
  targetId: string;
  gpuIds?: string[];
  gpuCount?: number;
  walltimeSeconds?: number | null;
  arraySize?: number | null;
  datasetPartitionVersionId?: string | null;
  maxAttempts?: number;
  retryOnFailure?: boolean;
  retryOnTimeout?: boolean;
  allowChildJobs?: boolean;
}

export interface ChildJobCreated {
  /** false when the key had been used: the response is what the first request created. */
  created: boolean;
  arrayGroupId: string | null;
  jobs: Job[];
}

export interface JobStatusCounts {
  queued: number;
  claimed: number;
  running: number;
  finished: number;
  failed: number;
  canceled: number;
  total: number;
}

/** GET /projects/:p/jobs/:j/children/wait: returns when every child ended or the wait timed out. */
export interface ChildJobWait {
  done: boolean;
  counts: JobStatusCounts;
}
