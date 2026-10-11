import type {
  Sweep,
  SweepStatus,
  SweepStatusReason,
  SweepTrial,
  SweepTrialCounts,
  SweepTrialState,
} from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import { notFound } from '../domain/errors.js';
import type { SweepCreateInput } from '../domain/sweepValidation.js';
import type { MetricPoint, TrialParameters } from '../domain/sweeps/types.js';
import { liveProjectSql } from './projectRepository.js';

/** A sweeps row without the per-trial aggregates that the API adds. */
export type StoredSweep = Omit<Sweep, 'trialCounts' | 'bestTrial'>;

export const ACTIVE_TRIAL_STATES: readonly SweepTrialState[] = ['queued', 'running'];
export const TERMINAL_SWEEP_STATUSES: readonly SweepStatus[] = ['finished', 'canceled', 'failed'];

// seed is bigint, which pg returns as a string.
const sweepColumns = `id,project_id,name,task_id,task_revision,experiment_id,method,search_space,
  objective,max_trials,parallelism,early_stopping,seed::float8 AS seed,target_id,gpu_ids,status,
  status_reason,created_by,created_at,updated_at,finished_at`;

// A queued trial whose Run a worker has claimed is reported as running before the next tick
// stores it, so reads do not lag the scheduler interval.
const effectiveTrialState = `CASE WHEN t.state='queued' AND r.status='running' THEN 'running' ELSE t.state END`;

const trialColumns = `t.id,t.sweep_id,t.trial_index,t.parameters,t.run_id,t.job_id,
  ${effectiveTrialState} AS state,t.objective_value,t.objective_step::float8 AS objective_step,
  t.stop_reason,r.status AS run_status,j.status AS job_status,j.cancel_requested AS job_cancel_requested,
  t.created_at,t.ended_at`;
const trialSource = 'sweep_trials t JOIN runs r ON r.id=t.run_id JOIN jobs j ON j.id=t.job_id';
const trialSelect = `SELECT ${trialColumns} FROM ${trialSource}`;

// Orders trials best first with plain row comparison: trials without an objective go last, and
// maximize is turned into ascending order by negating the value.
const objectiveSortKey = `(t.objective_value IS NULL)::int,
  COALESCE(CASE WHEN s.objective->>'goal'='maximize' THEN -t.objective_value ELSE t.objective_value END,0),
  t.trial_index`;

export async function insertSweep(
  connection: Connection,
  registration: {
    projectId: string;
    input: SweepCreateInput;
    taskRevision: number;
    experimentId: string;
    seed: number;
    createdBy: string;
  },
): Promise<StoredSweep> {
  const { input } = registration;
  return (await first<StoredSweep>(
    connection,
    `INSERT INTO sweeps(project_id,name,task_id,task_revision,experiment_id,method,search_space,objective,
    max_trials,parallelism,early_stopping,seed,target_id,gpu_ids,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,$12,$13,$14,$15) RETURNING ${sweepColumns}`,
    [
      registration.projectId,
      input.name,
      input.taskId,
      registration.taskRevision,
      registration.experimentId,
      input.method,
      JSON.stringify(input.searchSpace),
      JSON.stringify(input.objective),
      input.maxTrials,
      input.parallelism,
      input.earlyStopping ? JSON.stringify(input.earlyStopping) : null,
      registration.seed,
      input.targetId,
      input.gpuIds,
      registration.createdBy,
    ],
  ))!;
}

export async function findSweep(
  connection: Connection,
  reference: { projectId: string; id: string; lock?: boolean },
): Promise<StoredSweep> {
  const sweep = await first<StoredSweep>(
    connection,
    `SELECT ${sweepColumns} FROM sweeps WHERE project_id=$1 AND id=$2 ${reference.lock ? 'FOR UPDATE' : ''}`,
    [reference.projectId, reference.id],
  );
  if (!sweep) notFound('Sweep');
  return sweep;
}

/** For server-side callers that only know the id; undefined when the sweep does not exist. */
export async function lockSweepById(
  connection: Connection,
  sweepId: string,
): Promise<StoredSweep | undefined> {
  return first<StoredSweep>(
    connection,
    `SELECT ${sweepColumns} FROM sweeps WHERE id=$1 FOR UPDATE`,
    [sweepId],
  );
}

export async function updateSweepStatus(
  connection: Connection,
  change: { id: string; status: SweepStatus; statusReason: SweepStatusReason | null },
): Promise<StoredSweep> {
  return (await first<StoredSweep>(
    connection,
    `UPDATE sweeps SET status=$2,status_reason=$3,updated_at=now(),
    finished_at=CASE WHEN $2 IN ('finished','canceled','failed') THEN now() ELSE NULL END
    WHERE id=$1 RETURNING ${sweepColumns}`,
    [change.id, change.status, change.statusReason],
  ))!;
}

export async function updateSweepLimits(
  connection: Connection,
  change: { id: string; maxTrials: number; parallelism: number },
): Promise<StoredSweep> {
  return (await first<StoredSweep>(
    connection,
    `UPDATE sweeps SET max_trials=$2,parallelism=$3,updated_at=now() WHERE id=$1 RETURNING ${sweepColumns}`,
    [change.id, change.maxTrials, change.parallelism],
  ))!;
}

export async function listSweeps(
  connection: Connection,
  filter: { projectId: string; status?: SweepStatus; cursor?: string; limit: number },
): Promise<StoredSweep[]> {
  // Preserve PostgreSQL microseconds; JavaScript Date would truncate the keyset boundary.
  const boundary = filter.cursor
    ? await first<{ id: string; createdAt: string }>(
        connection,
        'SELECT id,created_at::text AS created_at FROM sweeps WHERE project_id=$1 AND id=$2',
        [filter.projectId, filter.cursor],
      )
    : undefined;
  if (filter.cursor && !boundary) notFound('Sweep cursor');
  return rows<StoredSweep>(
    connection,
    `SELECT ${sweepColumns} FROM sweeps WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
    AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
    ORDER BY created_at DESC,id DESC LIMIT $5`,
    [
      filter.projectId,
      filter.status ?? null,
      boundary?.createdAt ?? null,
      boundary?.id ?? null,
      filter.limit,
    ],
  );
}

/** Ids of sweeps the scheduler should visit. */
export async function listSchedulableSweepIds(connection: Connection): Promise<string[]> {
  // Sweeps of an archived Project wait untouched until it is restored.
  const found = await rows<{ id: string }>(
    connection,
    `SELECT s.id FROM sweeps s JOIN projects p ON p.id=s.project_id AND p.archived_at IS NULL
    WHERE s.status IN ('running','paused') ORDER BY s.updated_at,s.id`,
  );
  return found.map((sweep) => sweep.id);
}

function emptyTrialCounts(): SweepTrialCounts {
  return {
    total: 0,
    queued: 0,
    running: 0,
    finished: 0,
    failed: 0,
    canceled: 0,
    early_stopped: 0,
  };
}

export async function countTrialsBySweep(
  connection: Connection,
  sweepIds: readonly string[],
): Promise<Map<string, SweepTrialCounts>> {
  const counted = await rows<{ sweepId: string; state: SweepTrialState; count: number }>(
    connection,
    `SELECT t.sweep_id,${effectiveTrialState} AS state,count(*)::int AS count
    FROM sweep_trials t JOIN runs r ON r.id=t.run_id WHERE t.sweep_id=ANY($1::uuid[]) GROUP BY 1,2`,
    [sweepIds],
  );
  const counts = new Map(sweepIds.map((id) => [id, emptyTrialCounts()]));
  for (const { sweepId, state, count } of counted) {
    const sweepCounts = counts.get(sweepId)!;
    sweepCounts[state] += count;
    sweepCounts.total += count;
  }
  return counts;
}

/**
 * Best trial per sweep among trials that ran to an objective (finished or early_stopped).
 * Failed and canceled trials are left out: their last value reflects an interrupted run.
 */
export async function findBestTrials(
  connection: Connection,
  sweepIds: readonly string[],
): Promise<Map<string, SweepTrial>> {
  const best = await rows<SweepTrial>(
    connection,
    `SELECT DISTINCT ON (t.sweep_id) ${trialColumns} FROM ${trialSource} JOIN sweeps s ON s.id=t.sweep_id
    WHERE t.sweep_id=ANY($1::uuid[]) AND t.objective_value IS NOT NULL AND t.state IN ('finished','early_stopped')
    ORDER BY t.sweep_id,${objectiveSortKey}`,
    [sweepIds],
  );
  return new Map(best.map((trial) => [trial.sweepId, trial]));
}

export async function insertTrial(
  connection: Connection,
  trial: {
    sweepId: string;
    projectId: string;
    trialIndex: number;
    parameters: TrialParameters;
    runId: string;
    jobId: string;
  },
): Promise<void> {
  await connection.query(
    `INSERT INTO sweep_trials(sweep_id,project_id,trial_index,parameters,run_id,job_id)
    VALUES($1,$2,$3,$4::jsonb,$5,$6)`,
    [
      trial.sweepId,
      trial.projectId,
      trial.trialIndex,
      JSON.stringify(trial.parameters),
      trial.runId,
      trial.jobId,
    ],
  );
}

/** Every trial of a sweep in trial order, for the controller. */
export async function listSweepTrials(
  connection: Connection,
  sweepId: string,
): Promise<SweepTrial[]> {
  return rows<SweepTrial>(connection, `${trialSelect} WHERE t.sweep_id=$1 ORDER BY t.trial_index`, [
    sweepId,
  ]);
}

export async function findTrialByRunId(
  connection: Connection,
  runId: string,
): Promise<SweepTrial | undefined> {
  return first<SweepTrial>(connection, `${trialSelect} WHERE t.run_id=$1`, [runId]);
}

export async function listTrialPage(
  connection: Connection,
  page: {
    sweepId: string;
    orderBy: 'trial_index' | 'objective';
    cursor?: string;
    limit: number;
  },
): Promise<SweepTrial[]> {
  if (page.cursor) {
    const boundary = await first(
      connection,
      'SELECT id FROM sweep_trials WHERE sweep_id=$1 AND id=$2',
      [page.sweepId, page.cursor],
    );
    if (!boundary) notFound('SweepTrial cursor');
  }
  const sortKey = page.orderBy === 'objective' ? objectiveSortKey : 't.trial_index';
  return rows<SweepTrial>(
    connection,
    `${trialSelect} JOIN sweeps s ON s.id=t.sweep_id WHERE t.sweep_id=$1
    AND ($2::uuid IS NULL OR (${sortKey})>(SELECT ${sortKey} FROM sweep_trials t JOIN sweeps s ON s.id=t.sweep_id WHERE t.id=$2))
    ORDER BY ${sortKey} LIMIT $3`,
    [page.sweepId, page.cursor ?? null, page.limit],
  );
}

export async function markTrialsRunning(connection: Connection, sweepId: string): Promise<void> {
  await connection.query(
    `UPDATE sweep_trials t SET state='running' FROM runs r
    WHERE t.sweep_id=$1 AND t.state='queued' AND r.id=t.run_id AND r.status='running'`,
    [sweepId],
  );
}

/**
 * Stores the outcome of a trial whose Run reached a terminal status. An early-stopped trial keeps
 * its state and reason. Repeating this (an MLflow Run reopened and ended again) overwrites the
 * objective with the latest metrics.
 */
export async function finishTrial(
  connection: Connection,
  outcome: {
    trialId: string;
    state: Exclude<SweepTrialState, 'queued' | 'running' | 'early_stopped'>;
    objectiveValue: number | null;
    objectiveStep: number | null;
  },
): Promise<void> {
  await connection.query(
    `UPDATE sweep_trials SET state=CASE WHEN state='early_stopped' THEN state ELSE $2 END,
    objective_value=$3,objective_step=$4,ended_at=COALESCE(ended_at,now()) WHERE id=$1`,
    [outcome.trialId, outcome.state, outcome.objectiveValue, outcome.objectiveStep],
  );
}

export async function markTrialEarlyStopped(
  connection: Connection,
  stop: { trialId: string; stopReason: string },
): Promise<void> {
  await connection.query(
    "UPDATE sweep_trials SET state='early_stopped',stop_reason=$2 WHERE id=$1",
    [stop.trialId, stop.stopReason],
  );
}

/** Objective metric history per Run in step order. */
export async function listObjectiveHistories(
  connection: Connection,
  request: { runIds: readonly string[]; metric: string },
): Promise<Map<string, MetricPoint[]>> {
  const points = await rows<{ runId: string; step: number; value: number }>(
    connection,
    `SELECT run_id,step::float8 AS step,value FROM metrics WHERE run_id=ANY($1::uuid[]) AND name=$2
    ORDER BY run_id,step,timestamp,id`,
    [request.runIds, request.metric],
  );
  const histories = new Map<string, MetricPoint[]>(request.runIds.map((id) => [id, []]));
  for (const { runId, step, value } of points) histories.get(runId)!.push({ step, value });
  return histories;
}

/**
 * Whether the sweep's creator may still launch trials: an active user who is a Project editor or
 * admin by the effective role (direct grant, group binding or public visibility), or a global
 * administrator (who can act on any Project in a session). Nobody can in an archived Project.
 */
export async function hasSweepOwnerAccess(
  connection: Connection,
  sweep: Pick<StoredSweep, 'projectId' | 'createdBy'>,
): Promise<boolean> {
  const owner = await first<{ hasAccess: boolean }>(
    connection,
    `SELECT (u.status='active' AND ${liveProjectSql('$2')}
      AND (u.is_admin OR COALESCE(m.role IN ('editor','admin'),false))) AS has_access
    FROM users u LEFT JOIN effective_project_roles m ON m.user_id=u.id AND m.project_id=$2 WHERE u.id=$1`,
    [sweep.createdBy, sweep.projectId],
  );
  return owner?.hasAccess === true;
}
