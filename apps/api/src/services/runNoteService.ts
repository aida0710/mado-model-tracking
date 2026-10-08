import type { RunNote } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { storedRunNote } from '../domain/runNote.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { lockRunForNote, writeRunNote } from '../repositories/runNoteRepository.js';
import { rejectJobToken, requireProject } from './accessService.js';
import { auditActor, NO_REQUEST_METADATA, recordDenial } from './auditService.js';

/**
 * Edits the Run description stored in the mlflow.note.content tag.
 * A description is not an experiment result, so it stays editable after a Job's Run has ended.
 */
export class RunNoteService {
  constructor(private readonly database: Database) {}

  async update(
    principal: Principal,
    note: { projectId: string; runId: string; content: string },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<RunNote> {
    const { projectId, runId, content } = note;
    // The audit trail records the length only; the description itself may contain anything.
    const details = { length: content.length };
    const draft = {
      ...auditActor(principal),
      ...request,
      action: 'run.note.update',
      resourceType: 'run',
      resourceId: runId,
      projectId,
      details,
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        rejectJobToken(principal);
        await requireProject(connection, principal, {
          projectId,
          role: 'editor',
          scope: 'runs:write',
        });
        const run = await lockRunForNote(connection, { projectId, runId });
        if (!run) notFound('Run');
        if (run.lifecycleStage === 'deleted')
          throw new DomainError(409, '削除済みのRunは編集できません', 'run_deleted');
        await writeRunNote(connection, { runId, content: storedRunNote(content) });
        await writeAuditEvent(connection, { ...draft, outcome: 'success' });
        return { runId, content };
      }),
    );
  }
}
