import type {
  Job,
  JsonObject,
  Run,
  RunCheckpointArtifact,
  RunResumeCheckpointRecord,
  JobStatus,
} from '@mmt/contracts';

// Only interrupted training has something to continue; a finished Run is retried from scratch.
// A Job and its Run end with the same status, so the rule reads either one.
const RESUMABLE_STATUSES: readonly JobStatus[] = ['failed', 'canceled'];

/** Whether a Run or Job with this status can continue from one of the Run's checkpoints. */
export function isResumableStatus(status: JobStatus): boolean {
  return RESUMABLE_STATUSES.includes(status);
}

/**
 * Whether the screen offers "resume from this checkpoint": the API retries the Run's Job, so the
 * Run must have one, and retrying needs the editor role. The API stays the authority.
 */
export function canResumeFromCheckpoint({
  run,
  job,
  canEdit,
}: {
  run: Pick<Run, 'status'>;
  job: Pick<Job, 'status'> | undefined;
  canEdit: boolean;
}): boolean {
  if (!canEdit || !job) return false;
  return isResumableStatus(run.status) && isResumableStatus(job.status);
}

/** The Job that ran this Run. The jobs list is newest first, so a re-enqueued Run gets its newest Job. */
export function findRunJob(jobs: readonly Job[], runId: string): Job | undefined {
  return jobs.find((job) => job.runId === runId);
}

/**
 * Reads Run.environment.resume, which the server writes when the Run is pinned to a checkpoint.
 * Returns null for an ordinary Run or a record that does not have the contract's shape.
 */
export function getResumeCheckpointRecord(
  run: Pick<Run, 'environment'>,
): RunResumeCheckpointRecord | null {
  const record = run.environment.resume;
  if (!isJsonObject(record)) return null;
  const { checkpointId, sourceRunId, step } = record;
  if (typeof checkpointId !== 'string' || typeof sourceRunId !== 'string') return null;
  if (typeof step !== 'number' || !Number.isInteger(step)) return null;
  return { checkpointId, sourceRunId, step };
}

/** Whether a Run (a full Run or a search summary) continues from a checkpoint. */
export function isResumedRun(run: Pick<Run, 'resumeCheckpointId'>): boolean {
  return Boolean(run.resumeCheckpointId);
}

/** Ids of the Runs among `runs` that continue from a checkpoint. */
export function collectResumedRunIds(
  runs: readonly Pick<Run, 'id' | 'resumeCheckpointId'>[],
): Set<string> {
  return new Set(runs.filter(isResumedRun).map((run) => run.id));
}

/** File name offered when downloading a checkpoint Artifact; its path may contain folders. */
export function getCheckpointArtifactFileName(
  artifact: Pick<RunCheckpointArtifact, 'path'>,
): string {
  return artifact.path.split('/').pop() || artifact.path;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
