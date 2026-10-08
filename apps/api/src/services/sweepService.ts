import { randomInt } from 'node:crypto';
import type { Sweep, SweepPage, SweepTrialPage } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Connection, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import {
  MAX_SWEEP_SEED,
  validateSweepDefinition,
  type SweepCancelInput,
  type SweepCreateInput,
  type SweepListQuery,
  type SweepPatchInput,
  type SweepTrialQuery,
} from '../domain/sweepValidation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { findTask } from '../repositories/experimentTaskRepository.js';
import { findCodeVersion, lockActiveExperiment } from '../repositories/registryRepository.js';
import {
  countTrialsBySweep,
  findBestTrials,
  findSweep,
  insertSweep,
  listSweeps,
  listSweepTrials,
  listTrialPage,
  TERMINAL_SWEEP_STATUSES,
  updateSweepLimits,
  updateSweepStatus,
  type StoredSweep,
} from '../repositories/sweepRepository.js';
import { requireProject, requireScope } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';
import type { JobService } from './jobService.js';
import type { SweepController } from './sweepController.js';

interface SweepReference {
  projectId: string;
  sweepId: string;
}

type SweepChangeAction = 'sweep.pause' | 'sweep.resume' | 'sweep.cancel' | 'sweep.update';

/** Sweep API: authorization, validation and audit around SweepController's state machine. */
export class SweepService {
  constructor(
    private readonly database: Database,
    private readonly jobs: JobService,
    private readonly controller: SweepController,
  ) {}

  async create(
    principal: Principal,
    projectId: string,
    input: SweepCreateInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Sweep> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'sweep.create',
      resourceType: 'sweep',
      resourceId: null,
      projectId,
      details: { taskId: input.taskId, method: input.method },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await requireProject(connection, principal, {
          projectId,
          role: 'editor',
          scope: 'runs:write',
        });
        requireScope(principal, 'jobs:write');
        validateSweepDefinition(input);
        const task = await findTask(connection, { projectId, id: input.taskId });
        await lockActiveExperiment(connection, { projectId, id: task.experimentId });
        await this.validateTarget(connection, { projectId, input, task });
        const sweep = await insertSweep(connection, {
          projectId,
          input,
          taskRevision: task.revision,
          experimentId: task.experimentId,
          seed: input.seed ?? randomInt(MAX_SWEEP_SEED + 1),
          createdBy: principal.user.id,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          resourceId: sweep.id,
          details: { ...draft.details, maxTrials: sweep.maxTrials, parallelism: sweep.parallelism },
        });
        await this.controller.lock(connection, sweep.id);
        await this.controller.tick(connection, { sweepId: sweep.id, applyEarlyStopping: false });
        return this.present(connection, { projectId, sweepId: sweep.id });
      }),
    );
  }

  async list(principal: Principal, projectId: string, query: SweepListQuery): Promise<SweepPage> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    // Fetch one extra row to know whether another page exists without a count query.
    const stored = await listSweeps(this.database, { projectId, ...query, limit: query.limit + 1 });
    const items = await this.withTrialSummaries(this.database, stored.slice(0, query.limit));
    return { items, nextCursor: stored.length > query.limit ? items.at(-1)!.id : null };
  }

  async get(principal: Principal, reference: SweepReference): Promise<Sweep> {
    await requireProject(this.database, principal, {
      projectId: reference.projectId,
      role: 'viewer',
      scope: 'read',
    });
    return this.present(this.database, reference);
  }

  async trials(
    principal: Principal,
    reference: SweepReference & SweepTrialQuery,
  ): Promise<SweepTrialPage> {
    await requireProject(this.database, principal, {
      projectId: reference.projectId,
      role: 'viewer',
      scope: 'read',
    });
    await findSweep(this.database, { projectId: reference.projectId, id: reference.sweepId });
    const page = await listTrialPage(this.database, {
      sweepId: reference.sweepId,
      orderBy: reference.orderBy,
      cursor: reference.cursor,
      limit: reference.limit + 1,
    });
    const items = page.slice(0, reference.limit);
    return { items, nextCursor: page.length > reference.limit ? items.at(-1)!.id : null };
  }

  async pause(
    principal: Principal,
    reference: SweepReference,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Sweep> {
    return this.change(principal, {
      reference,
      action: 'sweep.pause',
      request,
      apply: async (connection, sweep) => {
        if (sweep.status !== 'running') return false;
        await updateSweepStatus(connection, {
          id: sweep.id,
          status: 'paused',
          statusReason: 'user_requested',
        });
        return true;
      },
    });
  }

  async resume(
    principal: Principal,
    reference: SweepReference,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Sweep> {
    return this.change(principal, {
      reference,
      action: 'sweep.resume',
      request,
      apply: async (connection, sweep) => {
        if (sweep.status !== 'paused') return false;
        const blocker = await this.controller.launchBlocker(connection, sweep);
        if (blocker === 'task_revision_changed')
          throw new DomainError(
            409,
            'Sweepの作成後にTaskが更新されたため再開できません。新しいSweepを作成してください',
            'task_revision_changed',
          );
        if (blocker === 'owner_forbidden')
          throw new DomainError(
            409,
            'Sweepの作成者にProjectのeditor権限がないため再開できません',
            'sweep_owner_forbidden',
          );
        await updateSweepStatus(connection, { id: sweep.id, status: 'running', statusReason: null });
        await this.controller.tick(connection, { sweepId: sweep.id, applyEarlyStopping: false });
        return true;
      },
    });
  }

  async cancel(
    principal: Principal,
    reference: SweepReference & SweepCancelInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Sweep> {
    return this.change(principal, {
      reference,
      action: 'sweep.cancel',
      request,
      details: { cancelRunningTrials: reference.cancelRunningTrials },
      beforeLock: (connection) => this.lockTrialJobs(connection, reference),
      apply: async (connection, sweep) => {
        // Set first so the completion handler, run for each canceled queued trial, launches nothing.
        await updateSweepStatus(connection, {
          id: sweep.id,
          status: 'canceled',
          statusReason: 'user_requested',
        });
        for (const trial of await listSweepTrials(connection, sweep.id))
          if (
            !isTerminalStatus(trial.jobStatus) &&
            (trial.jobStatus === 'queued' || reference.cancelRunningTrials)
          )
            await this.jobs.requestCancelInTransaction(connection, {
              projectId: sweep.projectId,
              jobId: trial.jobId,
            });
        return true;
      },
    });
  }

  async patch(
    principal: Principal,
    reference: SweepReference & { input: SweepPatchInput },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Sweep> {
    const { input } = reference;
    return this.change(principal, {
      reference,
      action: 'sweep.update',
      request,
      details: { ...input },
      apply: async (connection, sweep) => {
        const maxTrials = input.maxTrials ?? sweep.maxTrials;
        const created = (await listSweepTrials(connection, sweep.id)).length;
        if (maxTrials < created)
          throw new DomainError(
            422,
            `maxTrialsは作成済みの試行数（${created}）以上にしてください`,
            'sweep_max_trials_below_created',
          );
        await updateSweepLimits(connection, {
          id: sweep.id,
          maxTrials,
          parallelism: input.parallelism ?? sweep.parallelism,
        });
        await this.controller.tick(connection, { sweepId: sweep.id, applyEarlyStopping: false });
        return true;
      },
    });
  }

  /**
   * Shared flow of the creator-or-admin operations. apply returns false when the sweep is already
   * in the requested state; the call then succeeds without an audit event.
   */
  private async change(
    principal: Principal,
    operation: {
      reference: SweepReference;
      action: SweepChangeAction;
      request: RequestMetadata;
      details?: Record<string, boolean | number>;
      beforeLock?: (connection: Connection) => Promise<void>;
      apply: (connection: Connection, sweep: StoredSweep) => Promise<boolean>;
    },
  ): Promise<Sweep> {
    const { projectId, sweepId } = operation.reference;
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...operation.request,
      action: operation.action,
      resourceType: 'sweep',
      resourceId: sweepId,
      projectId,
      details: operation.details ?? {},
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        const role = await requireProject(connection, principal, {
          projectId,
          role: 'editor',
          scope: 'jobs:write',
        });
        const unlocked = await findSweep(connection, { projectId, id: sweepId });
        if (role !== 'admin' && unlocked.createdBy !== principal.user.id)
          throw new DomainError(
            403,
            'Sweepを操作できるのは作成者かProject adminだけです',
            'sweep_owner_required',
          );
        await operation.beforeLock?.(connection);
        await this.controller.lock(connection, sweepId);
        const sweep = await findSweep(connection, { projectId, id: sweepId, lock: true });
        if (TERMINAL_SWEEP_STATUSES.includes(sweep.status)) {
          if (operation.action === 'sweep.cancel' && sweep.status === 'canceled')
            return this.present(connection, operation.reference);
          throw new DomainError(409, '終了したSweepは変更できません', 'sweep_finished');
        }
        if (await operation.apply(connection, sweep))
          await writeAuditEvent(connection, { ...draft, outcome: 'success' });
        return this.present(connection, operation.reference);
      }),
    );
  }

  // A worker completing a trial locks its Job and then waits for the sweep lock in the
  // completion handler, so cancel takes the trial Job locks before the sweep lock.
  private async lockTrialJobs(connection: Connection, reference: SweepReference): Promise<void> {
    await connection.query(
      `SELECT j.id FROM jobs j JOIN sweep_trials t ON t.job_id=j.id
      WHERE t.sweep_id=$1 AND t.project_id=$2 AND j.status NOT IN ('finished','failed','canceled')
      ORDER BY j.id FOR UPDATE OF j`,
      [reference.sweepId, reference.projectId],
    );
  }

  private async validateTarget(
    connection: Connection,
    launch: {
      projectId: string;
      input: SweepCreateInput;
      task: { targetId: string | null; gpuIds: string[]; codeVersionId: string };
    },
  ): Promise<void> {
    const { input, task } = launch;
    const targetId = input.targetId ?? task.targetId;
    if (!targetId)
      throw new DomainError(422, '実行するComputeTargetを指定してください', 'target_required');
    const code = await findCodeVersion(connection, {
      projectId: launch.projectId,
      id: task.codeVersionId,
    });
    await this.jobs.validateTarget(connection, {
      targetId,
      gpuIds: input.gpuIds ?? task.gpuIds,
      runtime: code.runtime,
    });
  }

  private async present(connection: Connection, reference: SweepReference): Promise<Sweep> {
    const sweep = await findSweep(connection, {
      projectId: reference.projectId,
      id: reference.sweepId,
    });
    return (await this.withTrialSummaries(connection, [sweep]))[0]!;
  }

  private async withTrialSummaries(
    connection: Connection,
    sweeps: StoredSweep[],
  ): Promise<Sweep[]> {
    const ids = sweeps.map((sweep) => sweep.id);
    const counts = await countTrialsBySweep(connection, ids);
    const best = await findBestTrials(connection, ids);
    return sweeps.map((sweep) => ({
      ...sweep,
      trialCounts: counts.get(sweep.id)!,
      bestTrial: best.get(sweep.id) ?? null,
    }));
  }
}
