import {
  RUN_RESUME_REASON_MAX_LENGTH,
  type RunResumeEvent,
  type RunSegment,
  type RunStatus,
} from '@mmt/contracts';
import { z } from 'zod';
import { DomainError } from './errors.js';
import { isTerminalStatus } from './runTransitions.js';

/**
 * Rules for reopening an ended Run so later records continue the same Run, as MLflow's
 * start_run(run_id=) does. Native resume and MLflow update-run RUNNING share these rules.
 */

export const runResumeRequestSchema = z.strictObject({
  reason: z.string().max(RUN_RESUME_REASON_MAX_LENGTH).optional(),
});

/** A blank reason is the same as no reason, so the event never stores an empty string. */
export function storedResumeReason(reason: string | undefined): string | null {
  return reason?.trim() || null;
}

export interface ResumableRun {
  status: RunStatus;
  lifecycleStage: 'active' | 'deleted';
  startedAt: string | null;
}

export type RunResumeDecision =
  { resume: true; previousStatus: 'finished' | 'failed' | 'canceled' } | { resume: false };

/**
 * A resume reopens a running segment that actually happened. A Run canceled before it started
 * has no segment to continue, so moving it to running is a first start, not a resume.
 */
export function isResumeTransition(
  run: Pick<ResumableRun, 'status' | 'startedAt'>,
  nextStatus: RunStatus,
): boolean {
  return isTerminalStatus(run.status) && run.startedAt !== null && nextStatus === 'running';
}

export function decideRunResume(
  run: ResumableRun,
  context: { hasJob: boolean },
): RunResumeDecision {
  if (run.lifecycleStage === 'deleted')
    throw new DomainError(409, '削除済みのRunは再開できません', 'run_deleted');
  if (run.status === 'running') return { resume: false };
  if (!isTerminalStatus(run.status) || run.startedAt === null)
    throw new DomainError(409, '開始していないRunは再開できません', 'run_not_started');
  // The worker owns a Job's lifecycle and the ended Run is evidence for automation and evaluation.
  if (context.hasJob)
    throw new DomainError(
      409,
      'Jobが終了したRunは再開できません。checkpointから新しいRunとして再開してください',
      'run_finalized',
    );
  return { resume: true, previousStatus: run.status };
}

/** Splits a Run into running segments; events must be ordered by resumedAt. */
export function buildRunSegments(
  run: { status: RunStatus; startedAt: string; endedAt: string | null },
  events: readonly Pick<
    RunResumeEvent,
    'resumedAt' | 'previousStatus' | 'previousEndedAt' | 'maxStepAtResume'
  >[],
): RunSegment[] {
  const currentEnd = {
    endedAt: run.endedAt,
    endStatus: isTerminalStatus(run.status) ? run.status : null,
  };
  const endOfSegment = (index: number) => {
    const next = events[index];
    return next ? { endedAt: next.previousEndedAt, endStatus: next.previousStatus } : currentEnd;
  };
  const segments: RunSegment[] = [
    { startedAt: run.startedAt, ...endOfSegment(0), firstStep: null },
  ];
  events.forEach((event, index) => {
    segments.push({
      startedAt: event.resumedAt,
      ...endOfSegment(index + 1),
      firstStep: event.maxStepAtResume === null ? null : event.maxStepAtResume + 1,
    });
  });
  return segments;
}
