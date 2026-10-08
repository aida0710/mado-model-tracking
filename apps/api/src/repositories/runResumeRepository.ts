import type { Run, RunResumeEvent, RunResumeSource } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import { runColumns } from './runListProjection.js';

export interface LockedRunForResume {
  id: string;
  status: Run['status'];
  lifecycleStage: 'active' | 'deleted';
  startedAt: string | null;
  endedAt: string | null;
  hasJob: boolean;
}

// FOR UPDATE matches the MLflow status change: it waits for output registration and serializes
// concurrent resumes so only one of them records an event.
export async function lockRunForResume(
  connection: Connection,
  run: { projectId: string; runId: string },
): Promise<LockedRunForResume | undefined> {
  return first<LockedRunForResume>(
    connection,
    `SELECT id,status,lifecycle_stage,started_at,ended_at,
      EXISTS(SELECT 1 FROM jobs WHERE jobs.run_id=runs.id) AS has_job
    FROM runs WHERE id=$1 AND project_id=$2 FOR UPDATE OF runs`,
    [run.runId, run.projectId],
  );
}

/** Reopens the Run; the previous end time and error belong to the ended segment. */
export async function markRunResumed(connection: Connection, runId: string): Promise<Run> {
  return (await first<Run>(
    connection,
    `UPDATE runs SET status='running',ended_at=NULL,error=NULL WHERE id=$1 RETURNING ${runColumns}`,
    [runId],
  ))!;
}

interface RunResumeEventRow extends Omit<RunResumeEvent, 'maxStepAtResume'> {
  // bigint arrives as a string from pg.
  maxStepAtResume: string | null;
}

const runResumeEventColumns =
  'id,run_id,resumed_at,previous_status,previous_ended_at,max_step_at_resume,source,actor_user_id,reason';

function toRunResumeEvent(row: RunResumeEventRow): RunResumeEvent {
  return {
    ...row,
    maxStepAtResume: row.maxStepAtResume === null ? null : Number(row.maxStepAtResume),
  };
}

/**
 * Records a resume in the caller's transaction, before the Run row changes. The largest metric
 * step is read here so every source (native, MLflow, sync) computes it the same way.
 */
export async function insertRunResumeEvent(
  connection: Connection,
  event: {
    projectId: string;
    runId: string;
    previousStatus: RunResumeEvent['previousStatus'];
    previousEndedAt: string | null;
    source: RunResumeSource;
    actorUserId: string | null;
    actorTokenId: string | null;
    reason: string | null;
  },
): Promise<RunResumeEvent> {
  const row = (await first<RunResumeEventRow>(
    connection,
    `INSERT INTO run_resume_events(project_id,run_id,previous_status,previous_ended_at,
      max_step_at_resume,source,actor_user_id,actor_token_id,reason)
    VALUES($1,$2,$3,$4,(SELECT max(step) FROM metrics WHERE run_id=$2),$5,$6,$7,$8)
    RETURNING ${runResumeEventColumns}`,
    [
      event.projectId,
      event.runId,
      event.previousStatus,
      event.previousEndedAt,
      event.source,
      event.actorUserId,
      event.actorTokenId,
      event.reason,
    ],
  ))!;
  return toRunResumeEvent(row);
}

export async function listRunResumeEvents(
  connection: Connection,
  run: { projectId: string; runId: string },
): Promise<RunResumeEvent[]> {
  const events = await rows<RunResumeEventRow>(
    connection,
    `SELECT ${runResumeEventColumns} FROM run_resume_events
    WHERE project_id=$1 AND run_id=$2 ORDER BY resumed_at,id`,
    [run.projectId, run.runId],
  );
  return events.map(toRunResumeEvent);
}

/** Largest logged step per metric key, so a resumed client continues from the next step. */
export async function findLastMetricSteps(
  connection: Connection,
  runId: string,
): Promise<Record<string, number>> {
  const steps = await rows<{ name: string; step: string }>(
    connection,
    'SELECT name,max(step) AS step FROM metrics WHERE run_id=$1 GROUP BY name ORDER BY name',
    [runId],
  );
  return Object.fromEntries(steps.map(({ name, step }) => [name, Number(step)]));
}
