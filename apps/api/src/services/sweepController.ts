import type { SweepStatusReason, SweepTrial } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import { shouldStop } from '../domain/sweeps/hyperband.js';
import { countGridCombinations } from '../domain/sweeps/searchSpace.js';
import { suggestTrial } from '../domain/sweeps/suggestTrial.js';
import { computeObjective } from '../domain/sweeps/trialObjective.js';
import type {
  CompletedTrial,
  EarlyStoppingConfig,
  MetricPoint,
  SearchSpace,
  TrialParameters,
} from '../domain/sweeps/types.js';
import { findTask } from '../repositories/experimentTaskRepository.js';
import {
  ACTIVE_TRIAL_STATES,
  finishTrial,
  hasSweepOwnerAccess,
  insertTrial,
  listObjectiveHistories,
  listSweepTrials,
  lockSweepById,
  markTrialEarlyStopped,
  markTrialsRunning,
  TERMINAL_SWEEP_STATUSES,
  updateSweepStatus,
  type StoredSweep,
} from '../repositories/sweepRepository.js';
import type { JobService } from './jobService.js';
import type { TaskService } from './taskService.js';

// Reserved Run tags (mmt.* is server-only) that tie a trial Run to its sweep.
export const SWEEP_ID_TAG = 'mmt.sweepId';
export const SWEEP_TRIAL_INDEX_TAG = 'mmt.sweepTrialIndex';
export const SWEEP_EARLY_STOPPED_TAG = 'mmt.sweepEarlyStopped';
// Generated Run names follow the same limit as user-created Run names.
const RUN_NAME_LIMIT = 200;
const TRIAL_LAUNCH_SAVEPOINT = 'sweep_trial_launch';
// Shared by every API process on the same schema, like the other background locks.
const SWEEP_LOCK_PREFIX = 'sweep';

const COMPLETED_TRIAL_STATES = new Set(['finished', 'failed', 'early_stopped']);

/**
 * The sweep state machine: launches trials up to parallelism and max_trials, stops trials that
 * hyperband ranks below the rung cutoff, records trial outcomes and finishes the sweep. Every
 * entry point runs inside the caller's transaction while holding the sweep's advisory lock, so
 * the scheduler, the completion handler and the API never launch the same trial index twice.
 */
export class SweepController {
  constructor(
    private readonly tasks: TaskService,
    private readonly jobs: JobService,
  ) {}

  /** Waits for the sweep's lock until the transaction ends. Re-entrant within one transaction. */
  async lock(connection: Connection, sweepId: string): Promise<void> {
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1||':'||$2||':'||current_schema(),0))",
      [SWEEP_LOCK_PREFIX, sweepId],
    );
  }

  /** false when another transaction is advancing the sweep; the scheduler then skips it. */
  async tryLock(connection: Connection, sweepId: string): Promise<boolean> {
    const lock = await connection.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1||':'||$2||':'||current_schema(),0)) AS acquired",
      [SWEEP_LOCK_PREFIX, sweepId],
    );
    return lock.rows[0]?.acquired === true;
  }

  /**
   * Brings the sweep up to date. Early stopping cancels other trials' Jobs, so only the scheduler
   * asks for it; the completion handler, which already holds a finished trial's Run lock, does not.
   */
  async tick(
    connection: Connection,
    request: { sweepId: string; applyEarlyStopping: boolean },
  ): Promise<void> {
    const sweep = await lockSweepById(connection, request.sweepId);
    if (!sweep || TERMINAL_SWEEP_STATUSES.includes(sweep.status)) return;
    await markTrialsRunning(connection, sweep.id);
    const trials = await listSweepTrials(connection, sweep.id);
    // Normally the completion handler records outcomes; this catches a handler that failed.
    for (const trial of trials)
      if (ACTIVE_TRIAL_STATES.includes(trial.state) && isTerminalStatus(trial.runStatus))
        await this.recordOutcome(connection, { sweep, trial });
    if (request.applyEarlyStopping && sweep.earlyStopping)
      await this.stopTrialsBelowCutoff(connection, { sweep, trials });
    if (sweep.status === 'running') await this.launchTrials(connection, sweep);
  }

  /** Called from the terminal handler when a trial's Run ends: record it and refill the free slot. */
  async recordTrialEnd(connection: Connection, trial: SweepTrial): Promise<void> {
    await this.lock(connection, trial.sweepId);
    const sweep = await lockSweepById(connection, trial.sweepId);
    if (!sweep) return;
    await this.recordOutcome(connection, { sweep, trial });
    await this.tick(connection, { sweepId: sweep.id, applyEarlyStopping: false });
  }

  /** Why trials cannot be launched right now, or null. Also used before resuming. */
  async launchBlocker(
    connection: Connection,
    sweep: StoredSweep,
  ): Promise<'owner_forbidden' | 'task_revision_changed' | null> {
    // Like automation rules, the creator's access is rechecked at launch time.
    if (!(await hasSweepOwnerAccess(connection, sweep))) return 'owner_forbidden';
    const task = await findTask(connection, { projectId: sweep.projectId, id: sweep.taskId });
    return task.revision === sweep.taskRevision ? null : 'task_revision_changed';
  }

  private async recordOutcome(
    connection: Connection,
    outcome: { sweep: StoredSweep; trial: SweepTrial },
  ): Promise<void> {
    const { sweep, trial } = outcome;
    const runStatus = trial.runStatus;
    if (!isTerminalStatus(runStatus)) return;
    const histories = await listObjectiveHistories(connection, {
      runIds: [trial.runId],
      metric: sweep.objective.metric,
    });
    const history = histories.get(trial.runId)!;
    const objectiveValue = computeObjective(history, sweep.objective.aggregation);
    await finishTrial(connection, {
      trialId: trial.id,
      state: runStatus,
      objectiveValue,
      objectiveStep: findObjectiveStep(history, {
        objectiveValue,
        aggregation: sweep.objective.aggregation,
      }),
    });
  }

  private async stopTrialsBelowCutoff(
    connection: Connection,
    progress: { sweep: StoredSweep; trials: SweepTrial[] },
  ): Promise<void> {
    const { sweep, trials } = progress;
    const running = trials.filter((trial) => trial.state === 'running');
    if (running.length === 0) return;
    const started = trials.filter((trial) => trial.state !== 'queued');
    const histories = await listObjectiveHistories(connection, {
      runIds: started.map((trial) => trial.runId),
      metric: sweep.objective.metric,
    });
    const peers = started.map((trial) => ({
      trialIndex: trial.trialIndex,
      objectiveHistory: histories.get(trial.runId)!,
    }));
    for (const trial of running) {
      const decision = shouldStop({
        trialIndex: trial.trialIndex,
        objectiveHistory: histories.get(trial.runId)!,
        peers,
        goal: sweep.objective.goal,
        config: sweep.earlyStopping as EarlyStoppingConfig,
      });
      if (decision.stop)
        await this.stopTrial(connection, { sweep, trial, stopReason: `hyperband_rung_${decision.rung}` });
    }
  }

  private async stopTrial(
    connection: Connection,
    stop: { sweep: StoredSweep; trial: SweepTrial; stopReason: string },
  ): Promise<void> {
    const { sweep, trial } = stop;
    // A worker completing this Job holds its lock and then waits for this sweep's lock in the
    // completion handler; waiting here would deadlock, so the trial is left for the next tick.
    const job = await first<{ status: string }>(
      connection,
      'SELECT status FROM jobs WHERE id=$1 FOR UPDATE SKIP LOCKED',
      [trial.jobId],
    );
    // Only claimed/running Jobs: cancelling a queued Job would end its Run inside this tick.
    if (!job || job.status === 'queued' || isTerminalStatus(job.status)) return;
    await this.jobs.requestCancelInTransaction(connection, {
      projectId: sweep.projectId,
      jobId: trial.jobId,
    });
    await markTrialEarlyStopped(connection, { trialId: trial.id, stopReason: stop.stopReason });
    await connection.query(
      'UPDATE runs SET tags=tags||jsonb_build_object($2::text,$3::text) WHERE id=$1',
      [trial.runId, SWEEP_EARLY_STOPPED_TAG, 'true'],
    );
  }

  private async launchTrials(connection: Connection, sweep: StoredSweep): Promise<void> {
    const trials = await listSweepTrials(connection, sweep.id);
    let activeCount = trials.filter((trial) => ACTIVE_TRIAL_STATES.includes(trial.state)).length;
    let nextIndex = trials.length;
    const isExhausted = () =>
      sweep.method === 'grid' && nextIndex >= countGridCombinations(sweep.searchSpace as SearchSpace);
    const canLaunch = () =>
      activeCount < sweep.parallelism && nextIndex < sweep.maxTrials && !isExhausted();
    if (canLaunch()) {
      const blocker = await this.launchBlocker(connection, sweep);
      if (blocker) return this.setStatus(connection, { sweep, status: 'paused', reason: blocker });
    }
    const pendingParameters = trials
      .filter((trial) => ACTIVE_TRIAL_STATES.includes(trial.state))
      .map((trial) => trial.parameters as TrialParameters);
    while (canLaunch()) {
      const parameters = this.suggest(sweep, { trials, trialIndex: nextIndex, pendingParameters });
      if (!parameters)
        return this.setStatus(connection, { sweep, status: 'failed', reason: 'suggestion_failed' });
      if (!(await this.launchTrial(connection, { sweep, trialIndex: nextIndex, parameters })))
        return this.setStatus(connection, { sweep, status: 'paused', reason: 'launch_failed' });
      pendingParameters.push(parameters);
      activeCount += 1;
      nextIndex += 1;
    }
    if (activeCount > 0) return;
    if (nextIndex >= sweep.maxTrials)
      return this.setStatus(connection, { sweep, status: 'finished', reason: 'max_trials_reached' });
    if (isExhausted())
      return this.setStatus(connection, {
        sweep,
        status: 'finished',
        reason: 'search_space_exhausted',
      });
  }

  private suggest(
    sweep: StoredSweep,
    request: { trials: SweepTrial[]; trialIndex: number; pendingParameters: TrialParameters[] },
  ): TrialParameters | null {
    const completedTrials: CompletedTrial[] = request.trials
      .filter((trial) => COMPLETED_TRIAL_STATES.has(trial.state))
      .map((trial) => ({
        parameters: trial.parameters as TrialParameters,
        objective: trial.objectiveValue,
        state: trial.state as CompletedTrial['state'],
      }));
    try {
      const suggestion = suggestTrial({
        space: sweep.searchSpace as SearchSpace,
        method: sweep.method,
        goal: sweep.objective.goal,
        seed: sweep.seed,
        trialIndex: request.trialIndex,
        completedTrials,
        pendingParameters: request.pendingParameters,
      });
      // Grid exhaustion is detected before suggesting, so this is unreachable for valid sweeps.
      return 'parameters' in suggestion ? suggestion.parameters : null;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'sweep_suggestion_failed',
          sweepId: sweep.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  // Returns false when the Task launch is rejected (disabled target, deleted Experiment, ...);
  // the savepoint keeps the trial outcome already recorded in this transaction.
  private async launchTrial(
    connection: Connection,
    launch: { sweep: StoredSweep; trialIndex: number; parameters: TrialParameters },
  ): Promise<boolean> {
    const { sweep, trialIndex, parameters } = launch;
    await connection.query(`SAVEPOINT ${TRIAL_LAUNCH_SAVEPOINT}`);
    try {
      const task = await findTask(connection, { projectId: sweep.projectId, id: sweep.taskId });
      const suffix = `-${trialIndex}`;
      const execution = await this.tasks.launchTaskInTransaction(connection, {
        task,
        createdBy: sweep.createdBy,
        input: {
          executionMode: 'run',
          name: `${sweep.name.slice(0, RUN_NAME_LIMIT - suffix.length)}${suffix}`,
          parameters,
          ...(sweep.targetId ? { targetId: sweep.targetId } : {}),
          ...(sweep.gpuIds ? { gpuIds: sweep.gpuIds } : {}),
        },
        serverTags: { [SWEEP_ID_TAG]: sweep.id, [SWEEP_TRIAL_INDEX_TAG]: String(trialIndex) },
      });
      await insertTrial(connection, {
        sweepId: sweep.id,
        projectId: sweep.projectId,
        trialIndex,
        parameters,
        runId: execution.run.id,
        jobId: execution.job.id,
      });
    } catch (error) {
      await connection.query(`ROLLBACK TO SAVEPOINT ${TRIAL_LAUNCH_SAVEPOINT}`);
      console.error(
        JSON.stringify({
          event: 'sweep_trial_launch_failed',
          sweepId: sweep.id,
          trialIndex,
          code: error instanceof DomainError ? error.code : 'internal_error',
        }),
      );
      return false;
    }
    await connection.query(`RELEASE SAVEPOINT ${TRIAL_LAUNCH_SAVEPOINT}`);
    return true;
  }

  private async setStatus(
    connection: Connection,
    change: {
      sweep: StoredSweep;
      status: 'paused' | 'finished' | 'failed';
      reason: SweepStatusReason;
    },
  ): Promise<void> {
    await updateSweepStatus(connection, {
      id: change.sweep.id,
      status: change.status,
      statusReason: change.reason,
    });
  }
}

/** Step of the point that produced the objective, or null when there is no objective. */
function findObjectiveStep(
  history: readonly MetricPoint[],
  objective: { objectiveValue: number | null; aggregation: 'last' | 'min' | 'max' },
): number | null {
  if (objective.objectiveValue === null) return null;
  if (objective.aggregation === 'last')
    return history.reduce((latest, point) => Math.max(latest, point.step), -Infinity);
  return history.find((point) => point.value === objective.objectiveValue)?.step ?? null;
}
