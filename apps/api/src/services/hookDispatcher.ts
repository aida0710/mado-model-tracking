import { randomUUID } from 'node:crypto';
import {
  MAX_JOB_CHAIN_DEPTH,
  type Hook,
  type HookExecutionSubject,
  type HookSkipReason,
  type JobArrayGroup,
  type JsonObject,
  type ModelVersion,
  type Run,
  type RunCheckpoint,
} from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import { automationFailureMessage } from '../domain/automationFailure.js';
import { matchesHookFilter, type HookFilterSubject } from '../domain/hookFilter.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import { HOOK_EXECUTION_TAG, HOOK_TAG, INPUT_CHECKPOINT_TAG } from '../domain/serverRunTags.js';
import { findCheckpoint } from '../repositories/checkpointRepository.js';
import {
  countRecentStarts,
  findActiveHookRun,
  findExecutionIdByEvent,
  hasHookOwnerAccess,
  insertHookExecution,
  lockEnabledHooks,
  lockExpiredPendingExecutions,
  lockHook,
  lockPendingExecutions,
  updateHookExecution,
  type PendingHookExecution,
} from '../repositories/hookRepository.js';
import { findModelVersion, findRun } from '../repositories/registryRepository.js';
import type { CheckpointListener } from './checkpointService.js';
import type { JobArrayService } from './jobArrayService.js';
import type { JobService } from './jobService.js';
import type { ModelRegistrationListener } from './modelAutomationService.js';
import type { RunService } from './runService.js';

// Generated names follow the same limit as user-created Run names.
const RUN_NAME_LIMIT = 200;
const START_SAVEPOINT = 'hook_start';

/** Where a Job stands in a chain of hooks and drivers (jobs.hook_chain, jobs.chain_depth). */
export interface JobChain {
  hookChain: string[];
  chainDepth: number;
}

// A person's start (manual, webhook) begins a new chain.
const NEW_CHAIN: JobChain = { hookChain: [], chainDepth: 0 };

/** One thing that happened, as the hooks see it. */
export interface HookEvent {
  subjectKind: HookExecutionSubject;
  subjectId: string | null;
  // Unique per hook: a repeated event (a resent webhook, a Run reopened and ended again) finds
  // the execution it already has.
  eventKey: string;
  payload: JsonObject | null;
  requestedBy: string | null;
  chain: JobChain;
  // Shown in the names of the Runs the start creates.
  label: string;
  context: {
    // What inheritModelVersion takes; model_registered always uses it.
    modelVersionId: string | null;
    // What inheritOutputDatasets adds to the inputs.
    outputDatasetVersionIds: string[];
    // The Run the started Runs hang under.
    parentRunId: string | null;
    // checkpoint_saved: the checkpoint handed to the Job, and the Run that saved it.
    checkpointId: string | null;
    sourceRunId: string | null;
  };
}

type Decision =
  | { kind: 'start' }
  | { kind: 'skip'; reason: HookSkipReason }
  | { kind: 'pending'; waitingRunId: string };

const START: Decision = { kind: 'start' };
const skip = (reason: HookSkipReason): Decision => ({ kind: 'skip', reason });

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Starts hooks when their event happens (docs/hooks.md). Each start is a hook execution that
 * records whether a Job was created, why it was skipped, or which Run it waits for. Starts run
 * in the caller's transaction (a registration, a checkpoint, a Run's end) under a savepoint, so
 * a hook that cannot create its Job is recorded as failed without undoing the event.
 */
export class HookDispatcher implements ModelRegistrationListener, CheckpointListener {
  readonly name = 'hooks';
  private readonly runs: RunService;
  private readonly jobs: JobService;
  private readonly jobArrays: JobArrayService;
  constructor(options: { runs: RunService; jobs: JobService; jobArrays: JobArrayService }) {
    this.runs = options.runs;
    this.jobs = options.jobs;
    this.jobArrays = options.jobArrays;
  }

  async onModelRegistered(connection: Connection, model: ModelVersion): Promise<void> {
    const hooks = await lockEnabledHooks(connection, {
      projectId: model.projectId,
      trigger: 'model_registered',
    });
    if (!hooks.length) return;
    const sourceRun = model.sourceRunId
      ? await findRun(connection, { projectId: model.projectId, id: model.sourceRunId })
      : null;
    const subject: HookFilterSubject = {
      modelFamily: model.family,
      experimentId: sourceRun?.experimentId ?? null,
      runKind: sourceRun?.kind ?? null,
      runStatus: null,
      tags: sourceRun?.tags ?? {},
    };
    const event = await this.modelEvent(connection, { model, sourceRun, payload: null });
    for (const hook of hooks)
      if (matchesHookFilter(hook.filter, subject)) await this.dispatch(connection, { hook, event });
  }

  async onCheckpointSaved(
    connection: Connection,
    saved: { checkpoint: RunCheckpoint; run: Run },
  ): Promise<void> {
    const { checkpoint, run } = saved;
    const hooks = await lockEnabledHooks(connection, {
      projectId: run.projectId,
      trigger: 'checkpoint_saved',
    });
    if (!hooks.length) return;
    const subject = await this.runSubject(connection, run);
    const event = await this.checkpointEvent(connection, { checkpoint, run, payload: null });
    for (const hook of hooks) {
      if (!matchesHookFilter(hook.filter, subject)) continue;
      // every_k counts this Run's checkpoints in step order; the others leave no execution.
      if (hook.checkpointMode === 'every_k') {
        const ordinal = await this.checkpointOrdinal(connection, checkpoint);
        if (ordinal % hook.checkpointEvery! !== 0) continue;
      }
      await this.dispatch(connection, { hook, event });
    }
  }

  /** A Run ended: release what waited for it, then start the run_finished hooks. */
  async onRunEnded(connection: Connection, run: Run): Promise<void> {
    for (const pending of await lockPendingExecutions(connection, run.id))
      await this.releasePending(connection, pending);
    const hooks = await lockEnabledHooks(connection, {
      projectId: run.projectId,
      trigger: 'run_finished',
    });
    if (!hooks.length) return;
    const subject = { ...(await this.runSubject(connection, run)), runStatus: run.status };
    const event: HookEvent = {
      subjectKind: 'run',
      subjectId: run.id,
      eventKey: `run:${run.id}`,
      payload: { event: 'run_finished', runId: run.id, status: run.status },
      requestedBy: null,
      chain: await this.chainOfRun(connection, run.id),
      label: run.name,
      context: {
        modelVersionId: run.modelVersionId,
        outputDatasetVersionIds: run.outputDatasetVersionIds,
        parentRunId: run.id,
        checkpointId: null,
        sourceRunId: run.id,
      },
    };
    for (const hook of hooks)
      if (matchesHookFilter(hook.filter, subject)) await this.dispatch(connection, { hook, event });
  }

  /** Every member of the array has a final attempt (JobArrayCompletionHandler). */
  async onArrayFinished(connection: Connection, group: JobArrayGroup): Promise<void> {
    const hooks = await lockEnabledHooks(connection, {
      projectId: group.projectId,
      trigger: 'array_finished',
    });
    if (!hooks.length) return;
    // The final attempt of each index; earlier attempts were retried.
    const members = await rows<{ runId: string; status: string; chainDepth: number; hookChain: string[] }>(
      connection,
      `SELECT j.run_id,j.status,j.chain_depth,j.hook_chain FROM jobs j WHERE j.array_group_id=$1
      AND NOT EXISTS(SELECT 1 FROM jobs retry WHERE retry.retry_of_job_id=j.id)
      ORDER BY j.array_index`,
      [group.id],
    );
    if (!members.length) return;
    const counts = { finished: 0, failed: 0, canceled: 0 };
    for (const member of members) counts[member.status as keyof typeof counts] += 1;
    const status = counts.failed ? 'failed' : counts.canceled ? 'canceled' : 'finished';
    const firstRun = await findRun(connection, { projectId: group.projectId, id: members[0]!.runId });
    const outputs = await rows<{ id: string }>(
      connection,
      'SELECT DISTINCT unnest(output_dataset_version_ids) AS id FROM runs WHERE id=ANY($1::uuid[])',
      [members.map((member) => member.runId)],
    );
    const subject = { ...(await this.runSubject(connection, firstRun)), runStatus: status };
    const event: HookEvent = {
      subjectKind: 'array_group',
      subjectId: group.id,
      eventKey: `array_group:${group.id}`,
      payload: { event: 'array_finished', arrayGroupId: group.id, size: group.size, status, counts },
      requestedBy: null,
      chain: { hookChain: members[0]!.hookChain, chainDepth: members[0]!.chainDepth },
      label: firstRun.name.replace(/ \[\d+\]$/, ''),
      context: {
        modelVersionId: firstRun.modelVersionId,
        outputDatasetVersionIds: outputs.map((output) => output.id),
        parentRunId: null,
        checkpointId: null,
        sourceRunId: null,
      },
    };
    for (const hook of hooks)
      if (matchesHookFilter(hook.filter, subject)) await this.dispatch(connection, { hook, event });
  }

  /** A person's start: the manual trigger or a verified webhook delivery. */
  async dispatchRequest(
    connection: Connection,
    request: {
      hook: Hook;
      subjectKind: 'manual' | 'webhook';
      eventKey: string;
      payload: JsonObject;
      requestedBy: string | null;
    },
  ): Promise<string> {
    return this.dispatch(connection, {
      hook: request.hook,
      event: {
        subjectKind: request.subjectKind,
        subjectId: null,
        eventKey: request.eventKey,
        payload: request.payload,
        requestedBy: request.requestedBy,
        chain: NEW_CHAIN,
        label: request.subjectKind,
        context: {
          modelVersionId: null,
          outputDatasetVersionIds: [],
          parentRunId: null,
          checkpointId: null,
          sourceRunId: null,
        },
      },
    });
  }

  /** Pending executions whose Run never ended are skipped (HookSweeper). */
  async expirePending(
    connection: Connection,
    expiry: { maxAgeHours: number; limit: number },
  ): Promise<number> {
    const expired = await lockExpiredPendingExecutions(connection, expiry);
    for (const pending of expired)
      await updateHookExecution(connection, {
        id: pending.id,
        status: 'skipped',
        reason: 'source_run_timeout',
      });
    return expired.length;
  }

  /**
   * Records one start of a hook and creates its Job (or array) when nothing holds it back. A
   * pending execution passes its id to be decided again when the Run it waited for ends.
   */
  private async dispatch(
    connection: Connection,
    start: { hook: Hook; event: HookEvent; pendingId?: string },
  ): Promise<string> {
    const { hook, event } = start;
    if (!start.pendingId) {
      const existing = await findExecutionIdByEvent(connection, {
        hookId: hook.id,
        eventKey: event.eventKey,
      });
      if (existing) return existing;
    }
    const decision = await this.decide(connection, { hook, event });
    const id = start.pendingId ?? randomUUID();
    if (start.pendingId) {
      if (decision.kind !== 'start') {
        await updateHookExecution(connection, {
          id,
          status: decision.kind === 'skip' ? 'skipped' : 'pending',
          reason: decision.kind === 'skip' ? decision.reason : null,
          waitingRunId: decision.kind === 'pending' ? decision.waitingRunId : null,
        });
        return id;
      }
    } else {
      const inserted = await insertHookExecution(connection, {
        id,
        projectId: hook.projectId,
        hookId: hook.id,
        eventKey: event.eventKey,
        subjectKind: event.subjectKind,
        subjectId: event.subjectId,
        status: decision.kind === 'skip' ? 'skipped' : decision.kind === 'pending' ? 'pending' : 'queued',
        reason: decision.kind === 'skip' ? decision.reason : null,
        payload: event.payload,
        waitingRunId: decision.kind === 'pending' ? decision.waitingRunId : null,
        checkpointId: event.context.checkpointId,
        requestedBy: event.requestedBy,
      });
      // A concurrent delivery of the same event recorded it first.
      if (!inserted)
        return (await findExecutionIdByEvent(connection, {
          hookId: hook.id,
          eventKey: event.eventKey,
        }))!;
      if (decision.kind === 'pending' && hook.checkpointMode === 'latest')
        await this.supersedeOlderPending(connection, { hook, event, keepId: id });
      if (decision.kind !== 'start') return id;
    }
    await connection.query(`SAVEPOINT ${START_SAVEPOINT}`);
    try {
      const created = await this.createJobs(connection, { hook, event, executionId: id });
      await connection.query(`RELEASE SAVEPOINT ${START_SAVEPOINT}`);
      await updateHookExecution(connection, { id, status: 'queued', ...created });
    } catch (error) {
      await connection.query(`ROLLBACK TO SAVEPOINT ${START_SAVEPOINT}`);
      await updateHookExecution(connection, {
        id,
        status: 'failed',
        error: automationFailureMessage(error),
      });
    }
    return id;
  }

  private async decide(
    connection: Connection,
    start: { hook: Hook; event: HookEvent },
  ): Promise<Decision> {
    const { hook, event } = start;
    if (!hook.enabled) return skip('hook_disabled');
    if (!(await hasHookOwnerAccess(connection, hook))) return skip('owner_access_revoked');
    // A hook appears once per chain, so a hook started by its own Jobs' events stops there.
    if (event.chain.hookChain.includes(hook.id)) return skip('loop_detected');
    if (event.chain.chainDepth + 1 > MAX_JOB_CHAIN_DEPTH) return skip('chain_too_deep');
    if (hook.trigger === 'model_registered' && event.context.sourceRunId) {
      // A version registered during training waits until the training Run has finished.
      const source = await findRun(connection, {
        projectId: hook.projectId,
        id: event.context.sourceRunId,
      });
      if (!isTerminalStatus(source.status)) return { kind: 'pending', waitingRunId: source.id };
      if (source.status !== 'finished') return skip('source_run_unsuccessful');
    }
    if (
      hook.trigger === 'checkpoint_saved' &&
      (hook.checkpointMode === 'latest' || hook.checkpointMode === 'skip_if_running')
    ) {
      const active = await findActiveHookRun(connection, {
        hookId: hook.id,
        sourceRunId: event.context.sourceRunId ?? undefined,
      });
      if (active)
        return hook.checkpointMode === 'latest'
          ? { kind: 'pending', waitingRunId: active }
          : skip('already_running');
    }
    if (
      hook.concurrency === 'skip_if_running' &&
      (await findActiveHookRun(connection, { hookId: hook.id }))
    )
      return skip('already_running');
    if ((await countRecentStarts(connection, hook.id)) >= hook.maxStartsPerHour)
      return skip('rate_limited');
    return START;
  }

  private async createJobs(
    connection: Connection,
    start: { hook: Hook; event: HookEvent; executionId: string },
  ): Promise<{ jobId: string | null; runId: string | null; arrayGroupId: string | null }> {
    const { hook, event } = start;
    const { template } = hook;
    const { context } = event;
    const modelVersionId =
      hook.trigger === 'model_registered' || (template.inheritModelVersion && context.modelVersionId)
        ? context.modelVersionId
        : template.modelVersionId;
    const inherited = template.inheritOutputDatasets ? context.outputDatasetVersionIds : [];
    const inputDatasetVersionIds = unique([...template.inputDatasetVersionIds, ...inherited]);
    const serverTags: Record<string, string> = {
      [HOOK_TAG]: hook.id,
      [HOOK_EXECUTION_TAG]: start.executionId,
      ...(context.checkpointId ? { [INPUT_CHECKPOINT_TAG]: context.checkpointId } : {}),
    };
    const chain = {
      hookChain: [...event.chain.hookChain, hook.id],
      chainDepth: event.chain.chainDepth + 1,
    };
    const name = `${hook.name}: ${event.label}`.slice(0, RUN_NAME_LIMIT);
    if (template.arraySize !== null) {
      const created = await this.jobArrays.insertArray(connection, {
        projectId: hook.projectId,
        input: {
          experimentId: template.experimentId,
          name,
          kind: template.kind,
          codeVersionId: template.codeVersionId,
          modelVersionId,
          inputDatasetVersionIds,
          parameters: template.parameters,
          tags: template.tags,
          targetId: template.targetId,
          gpuCount: template.gpuCount,
          walltimeSeconds: template.walltimeSeconds,
          size: template.arraySize,
          maxAttempts: template.maxAttempts,
          retryOnFailure: template.retryOnFailure,
          retryOnTimeout: template.retryOnTimeout,
          allowChildJobs: template.allowChildJobs,
          datasetPartitionVersionId: template.datasetPartitionVersionId,
        },
        origin: {
          createdBy: hook.runAsUserId,
          parentRunId: context.parentRunId,
          serverTags,
          placement: { hookId: hook.id, ...chain },
        },
      });
      return { jobId: null, runId: null, arrayGroupId: created.arrayGroup.id };
    }
    const run = await this.runs.insertRun(connection, {
      projectId: hook.projectId,
      createdBy: hook.runAsUserId,
      input: {
        experimentId: template.experimentId,
        name,
        kind: template.kind,
        parameters: template.parameters,
        tags: { ...template.tags, ...serverTags },
        modelVersionId,
        codeVersionId: template.codeVersionId,
        inputDatasetVersionIds,
        parentRunId: context.parentRunId,
        environment: {},
      },
      // Inherited outputs stay apart from the hook's fixed inputs, like chained automation.
      upstreamDatasetVersionIds: inherited,
    });
    const job = await this.jobs.insertJob(connection, {
      run,
      input: {
        runId: run.id,
        targetId: template.targetId,
        gpuIds: template.gpuIds,
        gpuCount: template.gpuCount,
        walltimeSeconds: template.walltimeSeconds,
        maxAttempts: template.maxAttempts,
        retryOnFailure: template.retryOnFailure,
        retryOnTimeout: template.retryOnTimeout,
        allowChildJobs: template.allowChildJobs,
      },
      attempt: 1,
      placement: { hookId: hook.id, ...chain },
    });
    return { jobId: job.id, runId: run.id, arrayGroupId: null };
  }

  // Under 'latest' only the newest checkpoint of a Run waits; the older ones are superseded.
  private async supersedeOlderPending(
    connection: Connection,
    newest: { hook: Hook; event: HookEvent; keepId: string },
  ): Promise<void> {
    await connection.query(
      `UPDATE hook_executions e SET status='skipped',reason='superseded',updated_at=now()
      FROM run_checkpoints c
      WHERE e.hook_id=$1 AND e.status='pending' AND e.id<>$2 AND c.id=e.checkpoint_id AND c.run_id=$3`,
      [newest.hook.id, newest.keepId, newest.event.context.sourceRunId],
    );
  }

  private async releasePending(connection: Connection, pending: PendingHookExecution): Promise<void> {
    const hook = await lockHook(connection, { projectId: pending.projectId, id: pending.hookId });
    if (!hook) return;
    const event = await this.rebuildEvent(connection, pending);
    await this.dispatch(connection, { hook, event, pendingId: pending.id });
  }

  // A pending execution keeps its subject; the event is read again as it is now.
  private async rebuildEvent(
    connection: Connection,
    pending: PendingHookExecution,
  ): Promise<HookEvent> {
    if (pending.subjectKind === 'checkpoint') {
      const checkpoint = await findCheckpoint(connection, {
        projectId: pending.projectId,
        id: pending.checkpointId!,
      });
      const run = await findRun(connection, { projectId: pending.projectId, id: checkpoint.runId });
      return this.checkpointEvent(connection, { checkpoint, run, payload: pending.payload });
    }
    const model = await findModelVersion(connection, {
      projectId: pending.projectId,
      id: pending.subjectId!,
    });
    const sourceRun = model.sourceRunId
      ? await findRun(connection, { projectId: model.projectId, id: model.sourceRunId })
      : null;
    return this.modelEvent(connection, { model, sourceRun, payload: pending.payload });
  }

  private async modelEvent(
    connection: Connection,
    registered: { model: ModelVersion; sourceRun: Run | null; payload: JsonObject | null },
  ): Promise<HookEvent> {
    const { model, sourceRun } = registered;
    return {
      subjectKind: 'model_version',
      subjectId: model.id,
      eventKey: `model_version:${model.id}`,
      payload: registered.payload ?? {
        event: 'model_registered',
        modelVersionId: model.id,
        version: model.version,
        family: model.family,
      },
      requestedBy: null,
      chain: sourceRun ? await this.chainOfRun(connection, sourceRun.id) : NEW_CHAIN,
      label: model.version,
      context: {
        modelVersionId: model.id,
        outputDatasetVersionIds: [],
        parentRunId: model.sourceRunId,
        checkpointId: null,
        sourceRunId: model.sourceRunId,
      },
    };
  }

  private async checkpointEvent(
    connection: Connection,
    saved: { checkpoint: RunCheckpoint; run: Run; payload: JsonObject | null },
  ): Promise<HookEvent> {
    const { checkpoint, run } = saved;
    return {
      subjectKind: 'checkpoint',
      subjectId: checkpoint.id,
      eventKey: `checkpoint:${checkpoint.id}`,
      payload: saved.payload ?? {
        event: 'checkpoint_saved',
        runId: run.id,
        checkpointId: checkpoint.id,
        step: checkpoint.step,
      },
      requestedBy: null,
      chain: await this.chainOfRun(connection, run.id),
      label: `${run.name} step ${checkpoint.step}`,
      context: {
        modelVersionId: run.modelVersionId,
        outputDatasetVersionIds: [],
        parentRunId: run.id,
        checkpointId: checkpoint.id,
        sourceRunId: run.id,
      },
    };
  }

  private async runSubject(connection: Connection, run: Run): Promise<HookFilterSubject> {
    const model = run.modelVersionId
      ? await findModelVersion(connection, { projectId: run.projectId, id: run.modelVersionId })
      : null;
    return {
      modelFamily: model?.family ?? null,
      experimentId: run.experimentId,
      runKind: run.kind,
      runStatus: null,
      tags: run.tags,
    };
  }

  // A Run created by a person (or MLflow) has no Job and starts a new chain.
  private async chainOfRun(connection: Connection, runId: string): Promise<JobChain> {
    const job = await first<JobChain>(
      connection,
      'SELECT hook_chain,chain_depth FROM jobs WHERE run_id=$1',
      [runId],
    );
    return job ?? NEW_CHAIN;
  }

  private async checkpointOrdinal(connection: Connection, checkpoint: RunCheckpoint): Promise<number> {
    const counted = (await first<{ count: number }>(
      connection,
      'SELECT count(*)::int AS count FROM run_checkpoints WHERE run_id=$1 AND step<=$2',
      [checkpoint.runId, checkpoint.step],
    ))!;
    return counted.count;
  }
}
