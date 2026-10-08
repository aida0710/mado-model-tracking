import type {
  ArtifactPresence,
  Run,
  SyncBatchCounts,
  SyncBatchResult,
  SyncBatchStatus,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { assertNoReservedRunTags } from '../domain/reservedRunTags.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import {
  assertNotFutureTimestamp,
  type ArtifactPresenceCheckInput,
  type SyncBatchInput,
  type SyncRunCreateInput,
} from '../domain/runSyncValidation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { findRun } from '../repositories/registryRepository.js';
import {
  claimSyncBatch,
  findChangedParamKeys,
  findPresentArtifactPaths,
  findSyncBatchCounts,
  findSyncRunOwnership,
  lockSyncRunId,
  markSyncRunEnded,
  markSyncRunStarted,
  mergeSyncRunRecords,
  recordSyncBatchStatus,
  type SyncRunOwnership,
} from '../repositories/runSyncRepository.js';
import { appendLogs, appendMetrics } from '../repositories/telemetryRepository.js';
import { rejectJobToken, requireProject } from './accessService.js';
import { auditActor, NO_REQUEST_METADATA, recordDenial } from './auditService.js';
import type { RunCompletionService } from './runCompletionService.js';
import type { RunService } from './runService.js';

export interface SyncRunResult {
  run: Run;
  created: boolean;
}

/**
 * Sync writes only to Runs the same user created without a Job. A Job's Run is reported by the
 * worker online, and another user's Run with the same ID is a collision, not a resend.
 */
function assertSyncRunOwned(
  ownership: SyncRunOwnership,
  owner: { projectId: string; userId: string },
): void {
  if (
    ownership.projectId !== owner.projectId ||
    ownership.createdBy !== owner.userId ||
    ownership.hasJob ||
    ownership.lifecycleStage !== 'active'
  )
    throw new DomainError(
      409,
      'このRun IDは別のRunが使っているため後送りできません',
      'sync_run_conflict',
    );
}

function countBatch(batch: SyncBatchInput): SyncBatchCounts {
  return {
    metrics: batch.metrics.length,
    params: Object.keys(batch.params).length,
    tags: Object.keys(batch.tags).length,
    logs: batch.logs.length,
  };
}

/**
 * Receives Runs recorded where the API was unreachable. The client chooses the Run ID and every
 * batch ID, so a send that failed midway can be repeated from the start without duplicates.
 */
export class RunSyncService {
  constructor(
    private readonly database: Database,
    private readonly dependencies: {
      runs: RunService;
      runCompletion: RunCompletionService;
    },
  ) {}

  async createRun(
    principal: Principal,
    target: { projectId: string; runId: string; input: SyncRunCreateInput },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<SyncRunResult> {
    const { projectId, runId, input } = target;
    assertNoReservedRunTags(input.tags);
    assertNotFutureTimestamp(input.startedAt, {
      now: new Date(),
      field: 'startedAt',
    });
    const draft = {
      ...auditActor(principal),
      ...request,
      action: 'run.sync.create',
      resourceType: 'run',
      resourceId: runId,
      projectId,
      details: {},
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        // Offline recording is for manual Runs; a Job's Run is written by its worker online.
        rejectJobToken(principal);
        await requireProject(connection, principal, {
          projectId,
          role: 'editor',
          scope: 'runs:write',
        });
        await lockSyncRunId(connection, runId);
        const existing = await findSyncRunOwnership(connection, runId, {
          lock: false,
        });
        if (existing) {
          assertSyncRunOwned(existing, {
            projectId,
            userId: principal.user.id,
          });
          return {
            run: await findRun(connection, { projectId, id: runId }),
            created: false,
          };
        }
        const queued = await this.dependencies.runs.insertRun(connection, {
          id: runId,
          projectId,
          createdBy: principal.user.id,
          input: {
            experimentId: input.experimentId,
            name: input.name,
            kind: input.kind,
            parameters: input.parameters,
            tags: input.tags,
            parentRunId: input.parentRunId,
            inputDatasetVersionIds: [],
            environment: {},
          },
        });
        const run = await markSyncRunStarted(connection, {
          runId,
          startedAt: input.startedAt,
          origin: input.origin ?? null,
        });
        await this.dependencies.runCompletion.recordStatusChange(connection, {
          previousStatus: queued.status,
          run,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            experimentId: input.experimentId,
            origin: run.syncOrigin ?? null,
          },
        });
        return { run, created: true };
      }),
    );
  }

  async applyBatch(
    principal: Principal,
    target: { projectId: string; runId: string; batch: SyncBatchInput },
  ): Promise<SyncBatchResult> {
    const { projectId, runId, batch } = target;
    assertNoReservedRunTags(batch.tags);
    if (batch.status)
      assertNotFutureTimestamp(batch.status.endedAt, {
        now: new Date(),
        field: 'endedAt',
      });
    return transaction(this.database, async (connection) => {
      rejectJobToken(principal);
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      // The row lock orders batches of one Run, so a status batch and an older one never interleave.
      const ownership = await findSyncRunOwnership(connection, runId, {
        lock: true,
      });
      if (!ownership || ownership.projectId !== projectId) notFound('Run');
      assertSyncRunOwned(ownership, { projectId, userId: principal.user.id });
      const counts = countBatch(batch);
      const claimed = await claimSyncBatch(connection, {
        projectId,
        runId,
        batchId: batch.batchId,
        sequence: batch.sequence,
        counts,
      });
      if (!claimed)
        return {
          applied: false,
          duplicate: true,
          counts: await findSyncBatchCounts(connection, {
            runId,
            batchId: batch.batchId,
          }),
        };
      const changedKeys = await findChangedParamKeys(connection, {
        runId,
        params: batch.params,
      });
      if (changedKeys.length > 0)
        throw new DomainError(
          409,
          `記録済みのparamは別の値に変更できません: ${changedKeys.join(', ')}`,
          'sync_param_conflict',
        );
      if (counts.params > 0 || counts.tags > 0)
        await mergeSyncRunRecords(connection, {
          runId,
          params: batch.params,
          tags: batch.tags,
        });
      // Client timestamps and steps are kept, so the series reads as if it had been logged live.
      if (counts.metrics > 0) await appendMetrics(connection, runId, batch.metrics);
      if (counts.logs > 0) await appendLogs(connection, runId, batch.logs);
      if (batch.status && (await this.endRun(connection, { projectId, runId, end: batch.status })))
        await recordSyncBatchStatus(connection, {
          runId,
          batchId: batch.batchId,
          status: batch.status.status,
        });
      return { applied: true, duplicate: false, counts };
    });
  }

  /**
   * Ends the Run with the client's end. Returns false when it already has that status (the end
   * was sent again in a new batch); a different end is refused rather than overwritten.
   */
  private async endRun(
    connection: Connection,
    target: { projectId: string; runId: string; end: SyncBatchStatus },
  ): Promise<boolean> {
    const { projectId, runId, end } = target;
    const run = await findRun(connection, { projectId, id: runId });
    if (run.status === end.status) return false;
    if (isTerminalStatus(run.status))
      throw new DomainError(
        409,
        `Runは既に${run.status}で終わっているため${end.status}にできません`,
        'sync_status_conflict',
      );
    if (run.startedAt !== null && Date.parse(end.endedAt) < Date.parse(run.startedAt))
      throw new DomainError(422, 'endedAtがRunの開始より前です', 'sync_ended_before_start');
    const ended = await markSyncRunEnded(connection, {
      runId,
      status: end.status,
      endedAt: end.endedAt,
      error: end.error ?? null,
    });
    await this.dependencies.runCompletion.recordStatusChange(connection, {
      previousStatus: run.status,
      run: ended,
    });
    return true;
  }

  async checkArtifacts(
    principal: Principal,
    target: {
      projectId: string;
      runId: string;
      check: ArtifactPresenceCheckInput;
    },
  ): Promise<ArtifactPresence> {
    const { projectId, runId, check } = target;
    rejectJobToken(principal);
    // Only a client about to upload asks, so the same access as uploading is required.
    await requireProject(this.database, principal, {
      projectId,
      role: 'editor',
      scope: 'artifacts:write',
    });
    await findRun(this.database, { projectId, id: runId });
    if (check.items.length === 0) return { present: [] };
    return {
      present: await findPresentArtifactPaths(this.database, {
        projectId,
        runId,
        items: check.items,
      }),
    };
  }
}
