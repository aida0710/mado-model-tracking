import type { AdminProject } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { purgeProjectRows } from '../repositories/projectPurgeRepository.js';
import {
  findAdminProject,
  listAdminProjects,
  lockProjectLifecycle,
  markProjectPurged,
  unarchiveProject,
} from '../repositories/projectRepository.js';
import { requireGlobalAdmin } from './accessService.js';
import { requireSession } from './tokenService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';

/**
 * What a global administrator does with every Project (/admin/projects): list them with their
 * archived ones, restore an archived Project, and purge one for good.
 */
export class ProjectAdministrationService {
  constructor(private readonly database: Database) {}

  async list(principal: Principal, query: { includeArchived: boolean }): Promise<AdminProject[]> {
    requireGlobalAdmin(principal);
    return listAdminProjects(this.database, query);
  }

  /** Brings an archived Project back as it was; restoring a live Project changes nothing. */
  async restore(
    principal: Principal,
    projectId: string,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<AdminProject> {
    const draft = this.auditDraft(principal, { action: 'project.restore', projectId, request });
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        requireGlobalAdmin(principal);
        const project = await lockProjectLifecycle(connection, projectId);
        if (!project) notFound('Project');
        if (project.archivedAt) {
          await unarchiveProject(connection, projectId);
          await writeAuditEvent(connection, {
            ...draft,
            outcome: 'success',
            details: { name: project.name, archivedAt: project.archivedAt },
          });
        }
        return (await findAdminProject(connection, projectId))!;
      }),
    );
  }

  /**
   * Deletes an archived Project's rows in one transaction and queues its blobs, which the
   * ArtifactGarbageCollector removes from storage after the commit (see projectPurgeRepository).
   * It cannot be undone, so like user administration it takes a browser session, not a token.
   */
  async purge(
    principal: Principal,
    projectId: string,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<void> {
    const draft = this.auditDraft(principal, { action: 'project.purge', projectId, request });
    await recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        requireGlobalAdmin(principal);
        requireSession(principal, 'Projectの完全な削除');
        const project = await lockProjectLifecycle(connection, projectId);
        if (!project) notFound('Project');
        if (!project.archivedAt)
          throw new DomainError(
            409,
            'アーカイブしていないProjectは完全に削除できません',
            'project_not_archived',
          );
        // Marked first: the history triggers let only a purged Project's rows be deleted.
        await markProjectPurged(connection, { projectId, purgedBy: principal.user.id });
        const purged = await purgeProjectRows(connection, projectId);
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: { name: project.name, ...purged },
        });
      }),
    );
  }

  private auditDraft(
    principal: Principal,
    event: { action: string; projectId: string; request: RequestMetadata },
  ): AuditEventDraft {
    return {
      ...auditActor(principal),
      ...event.request,
      action: event.action,
      resourceType: 'project',
      resourceId: event.projectId,
      projectId: event.projectId,
    };
  }
}
