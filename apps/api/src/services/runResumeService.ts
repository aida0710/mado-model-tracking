import type { RunResumeEventPage, RunResumeResult } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Database } from '../db/database.js';
import { notFound } from '../domain/errors.js';
import { buildRunSegments, decideRunResume, storedResumeReason } from '../domain/runResume.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { findRun } from '../repositories/registryRepository.js';
import {
  findLastMetricSteps,
  insertRunResumeEvent,
  listRunResumeEvents,
  lockRunForResume,
  markRunResumed,
} from '../repositories/runResumeRepository.js';
import { rejectJobToken, requireProject } from './accessService.js';
import { auditActor, NO_REQUEST_METADATA, recordDenial } from './auditService.js';
import type { RunCompletionService } from './runCompletionService.js';

/**
 * Reopens an ended Run without a Job so the SDK can append to it (wandb resume, MLflow
 * start_run(run_id=)). Each reopening is kept as an append-only resume event.
 */
export class RunResumeService {
  constructor(
    private readonly database: Database,
    private readonly runCompletion: RunCompletionService,
  ) {}

  async resume(
    principal: Principal,
    target: { projectId: string; runId: string; reason?: string },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<RunResumeResult> {
    const { projectId, runId } = target;
    const reason = storedResumeReason(target.reason);
    const draft = {
      ...auditActor(principal),
      ...request,
      action: 'run.resume',
      resourceType: 'run',
      resourceId: runId,
      projectId,
      details: {},
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        // A Job's code may write its own Run but never reopen it: a Job-owned Run is final.
        rejectJobToken(principal);
        await requireProject(connection, principal, {
          projectId,
          role: 'editor',
          scope: 'runs:write',
        });
        const locked = await lockRunForResume(connection, { projectId, runId });
        if (!locked) notFound('Run');
        const lastSteps = await findLastMetricSteps(connection, runId);
        const decision = decideRunResume(locked, { hasJob: locked.hasJob });
        if (!decision.resume)
          return {
            run: await findRun(connection, { projectId, id: runId }),
            resumed: false,
            event: null,
            lastSteps,
          };
        const event = await insertRunResumeEvent(connection, {
          projectId,
          runId,
          previousStatus: decision.previousStatus,
          previousEndedAt: locked.endedAt,
          source: 'native',
          actorUserId: principal.user.id,
          actorTokenId: principal.token?.id ?? null,
          reason,
        });
        const run = await markRunResumed(connection, runId);
        await this.runCompletion.recordStatusChange(connection, {
          previousStatus: decision.previousStatus,
          run,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            eventId: event.id,
            previousStatus: decision.previousStatus,
            hasReason: reason !== null,
          },
        });
        return { run, resumed: true, event, lastSteps };
      }),
    );
  }

  async listEvents(
    principal: Principal,
    target: { projectId: string; runId: string },
  ): Promise<RunResumeEventPage> {
    return transaction(this.database, async (connection) => {
      // The events and the Run's current end must come from the same snapshot to form segments.
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await requireProject(connection, principal, {
        projectId: target.projectId,
        role: 'viewer',
        scope: 'read',
      });
      const run = await findRun(connection, { projectId: target.projectId, id: target.runId });
      const items = await listRunResumeEvents(connection, target);
      const segments =
        run.startedAt === null ? [] : buildRunSegments({ ...run, startedAt: run.startedAt }, items);
      return { items, segments };
    });
  }
}
