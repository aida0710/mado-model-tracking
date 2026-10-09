import type { ComputeTarget, Job, JsonObject, LogEntry, MetricPoint, RunKind, WorkerJob } from './index.js';
import type { WorkerOutputDeclaration } from './workerOutputs.js';

/**
 * Sites (ComputeTarget.executor='site') are computers tracking only describes. A launcher, or the
 * requester with `mado-tracking submit` where logins need a one-time password, runs the site's
 * job shell; the runner on the compute node then reports back with the Job token. Tracking never
 * holds a site's connection settings, scheduler options or keys (docs/sites.md).
 */
export type SiteSubmissionMode = 'automatic' | 'manual';
export const SITE_SUBMISSION_MODES: readonly SiteSubmissionMode[] = ['automatic', 'manual'];

/** CPU of a site's compute nodes; container images and SIFs must be built for it. */
export type CpuArch = 'amd64' | 'arm64';
export const CPU_ARCHES: readonly CpuArch[] = ['amd64', 'arm64'];

/**
 * Where a site Job is between queued and its end:
 * waiting_manual (queued; the requester submits it by hand), submitting (claimed for submission),
 * submitted (in the scheduler queue), waiting_resources (the runner waits for free GPUs),
 * running (the container runs). ssh and local Jobs have no phase.
 */
export type JobPhase =
  | 'waiting_manual'
  | 'submitting'
  | 'submitted'
  | 'waiting_resources'
  | 'running';
export const JOB_PHASES: readonly JobPhase[] = [
  'waiting_manual',
  'submitting',
  'submitted',
  'waiting_resources',
  'running',
];

/**
 * Why a site Job ended beyond its status: the scheduler stopped it at its time limit (timed_out),
 * it waited in the queue longer than the site allows (queue_timeout), or the job shell refused it
 * (submit_failed).
 */
export type JobEndReason = 'timed_out' | 'queue_timeout' | 'submit_failed';
export const JOB_END_REASONS: readonly JobEndReason[] = ['timed_out', 'queue_timeout', 'submit_failed'];

/** Members of one array; each index is its own Run and Job. */
export const MAX_JOB_ARRAY_SIZE = 10000;
/** GPUs one Job may request; also the database limit of jobs.gpu_count. */
export const MAX_JOB_GPU_COUNT = 64;
/** The longest time limit a Job may request (30 days); the site's job shell may allow less. */
export const MAX_JOB_WALLTIME_SECONDS = 30 * 24 * 60 * 60;
/** Submissions one claim returns; an array counts as one submission. */
export const SITE_CLAIM_MAX_SUBMISSIONS = 50;
/** A claimed submission without a report for this long is failed as submit_failed. */
export const SITE_SUBMISSION_REPORT_TIMEOUT_SECONDS = 15 * 60;

export interface JobArrayGroup {
  id: string;
  projectId: string;
  targetId: string;
  size: number;
  createdBy: string;
  parentJobId: string | null;
  hookId: string | null;
  /** Set when every member has a terminal attempt and no retry remains to start. */
  finishedAt: string | null;
  createdAt: string;
}

/** POST /projects/:p/job-arrays: one Run and Job per index, submitted together to the site. */
export interface JobArrayCreate {
  experimentId: string;
  name: string;
  kind: RunKind;
  codeVersionId: string;
  modelVersionId?: string | null;
  inputDatasetVersionIds?: string[];
  parameters?: JsonObject;
  tags?: Record<string, string>;
  targetId: string;
  gpuCount?: number;
  walltimeSeconds?: number | null;
  size: number;
  maxAttempts?: number;
  retryOnFailure?: boolean;
  retryOnTimeout?: boolean;
  allowChildJobs?: boolean;
  /** An 'artifacts' input version whose files are split among the members (docs/sites.md). */
  datasetPartitionVersionId?: string | null;
}

export interface JobArrayCreated {
  arrayGroup: JobArrayGroup;
  jobs: Job[];
}

/** Who the submission runs for; the launcher picks that person's account on personal sites. */
export interface SiteSubmissionRequester {
  id: string;
  email: string;
  username: string | null;
}

/** One job shell call: a single Job, or every member of an array on a site that takes arrays. */
export interface SiteSubmission {
  target: ComputeTarget;
  arrayGroupId: string | null;
  requester: SiteSubmissionRequester;
  jobs: WorkerJob[];
}

/** POST /worker/site-submissions/claim with a project worker token. */
export interface SiteSubmissionClaim {
  launcherId: string;
  targetIds?: string[];
  limit?: number;
}

/** POST /manual-submissions/claim with the requester's own API token. */
export interface ManualSubmissionClaim {
  targetId: string;
  submitterId: string;
  limit?: number;
}

export interface SiteSubmissionResult {
  jobIds: string[];
  outcome: 'submitted' | 'failed';
  /** The scheduler's ID printed by the job shell; null on direct hosts without a scheduler. */
  schedulerJobId?: string | null;
  error?: string | null;
}

export interface SiteSubmissionReport {
  launcherId: string;
  results: SiteSubmissionResult[];
}

export interface ManualSubmissionReport {
  submitterId: string;
  results: SiteSubmissionResult[];
}

/** GET /manual-submissions: the requester's Jobs waiting for `mado-tracking submit`, per site. */
export interface ManualSubmissionWaiting {
  targetId: string;
  targetName: string;
  waitingJobs: number;
}

/** A Job canceled while it waited in the scheduler queue; the launcher runs the cancel command. */
export interface SiteSchedulerCancellation {
  jobId: string;
  targetId: string;
  schedulerJobId: string;
}

export interface SiteSchedulerCancellationReport {
  launcherId: string;
  jobIds: string[];
}

/** Runner protocol (POST /projects/:p/jobs/:j/runner/*) with the Job token. */
export type RunnerPhase = 'waiting_resources' | 'running';

export interface RunnerStart {
  /** Chosen by the runner once; another runner of the same Job is refused (runner_conflict). */
  instanceId: string;
  host: string;
  gpuIds: string[];
  phase: RunnerPhase;
}

export interface RunnerHeartbeat {
  instanceId: string;
  phase?: RunnerPhase;
  gpuIds?: string[];
}

export interface RunnerState {
  job: Job;
  cancelRequested: boolean;
}

export interface RunnerLogs {
  instanceId: string;
  entries: LogEntry[];
}

export interface RunnerMetrics {
  instanceId: string;
  metrics: MetricPoint[];
}

export interface RunnerOutputs {
  instanceId: string;
  declarations: WorkerOutputDeclaration[];
}

export interface RunnerFinish {
  instanceId: string;
  status: 'finished' | 'failed' | 'canceled';
  exitCode?: number;
  error?: string;
  /** timed_out: the scheduler's termination signal arrived (time limit). */
  endReason?: 'timed_out';
}

export interface RunnerFinishResult {
  job: Job;
  /** The automatic retry this end started (retryOnFailure / retryOnTimeout); null if none. */
  retryJobId: string | null;
}
