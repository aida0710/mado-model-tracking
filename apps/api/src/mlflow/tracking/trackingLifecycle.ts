import type { RunStatus } from '@mmt/contracts';
import { conflict } from '../../domain/errors.js';
import { isResumeTransition } from '../../domain/runResume.js';
import { isTerminalStatus } from '../../domain/runTransitions.js';
import { nativeRunStatus, type MlflowRunStatus, type TrackingRun } from './trackingTypes.js';

export function resolveTrackingLifecycle(
  run: TrackingRun,
  input: { status?: MlflowRunStatus; endTime?: number | null; hasJob: boolean },
) {
  if (input.hasJob) {
    if (input.status === 'SCHEDULED' && run.status !== 'queued')
      conflict('Jobが管理するRunをキューへ戻せません');
    // SDK start/end only changes its local context; the worker owns a Job's lifecycle.
    return { status: run.status, startedAt: run.startedAt, endedAt: run.endedAt };
  }
  const status = input.status ? nativeRunStatus[input.status] : run.status;
  const now = new Date().toISOString();
  const startedAt = status === 'running' ? (run.startedAt ?? now) : run.startedAt;
  let endedAt = run.endedAt;
  if (input.status === 'RUNNING') endedAt = null;
  else if (input.endTime != null) endedAt = new Date(input.endTime).toISOString();
  else if (isTerminalStatus(status)) endedAt ??= now;
  return { status, startedAt, endedAt };
}

/**
 * MLflow's start_run(run_id=) sends update-run RUNNING with the previous end_time (verified with
 * SDK 3.0.0 and 3.17.0). For a Run without a Job this reopens an ended Run and is recorded as a
 * resume like the native API; a Job-owned Run keeps its status and so never resumes.
 */
export function isTrackingResume(
  run: TrackingRun,
  next: { status: RunStatus; hasJob: boolean },
): boolean {
  return !next.hasJob && isResumeTransition(run, next.status);
}
