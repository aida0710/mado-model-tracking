import type { AuditEventPage } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { Database } from '../db/database.js';
import type { AuditEventQuery, ProjectAuditEventQuery } from '../domain/auditValidation.js';
import { DomainError, notFound } from '../domain/errors.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import {
  auditCursorExists,
  listAuditEvents,
  writeAuditEvent,
  type AuditEventFilter,
  type AuditEventInput,
} from '../repositories/auditRepository.js';
import { requireGlobalAdmin, requireProject } from './accessService.js';

// Internal callers such as the demo seed have no HTTP request to attribute.
export const NO_REQUEST_METADATA: RequestMetadata = { ip: null, userAgent: null };

// Only authorization refusals are recorded as denied; validation and missing resources are not.
export const DENIED_STATUSES: ReadonlySet<number> = new Set([403, 409]);

export type AuditEventDraft = Omit<AuditEventInput, 'outcome'>;

export function auditActor(
  principal: Principal,
): Pick<AuditEventInput, 'actorType' | 'actorUserId' | 'actorTokenId'> {
  return principal.token
    ? { actorType: 'token', actorUserId: principal.user.id, actorTokenId: principal.token.id }
    : { actorType: 'user', actorUserId: principal.user.id, actorTokenId: null };
}

/**
 * Runs an operation and records a 403/409 refusal as a denied audit event.
 * The denied row is written on the pool, outside the operation's transaction, because that
 * transaction has already rolled back when the refusal reaches this point.
 */
export async function recordDenial<T>(
  database: Database,
  draft: AuditEventDraft,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DomainError && DENIED_STATUSES.has(error.status))
      await writeAuditEvent(database, {
        ...draft,
        outcome: 'denied',
        details: { ...draft.details, code: error.code },
      });
    throw error;
  }
}

export class AuditService {
  constructor(readonly database: Database) {}

  async list(principal: Principal, query: AuditEventQuery): Promise<AuditEventPage> {
    // A session is required: unlike Project-scoped reads, the global log is not exposed to tokens.
    if (principal.method !== 'session')
      throw new DomainError(
        403,
        '監査ログの全体一覧にはブラウザでのloginが必要です',
        'session_required',
      );
    requireGlobalAdmin(principal);
    return this.page(query);
  }

  async listForProject(
    principal: Principal,
    projectId: string,
    query: ProjectAuditEventQuery,
  ): Promise<AuditEventPage> {
    await requireProject(this.database, principal, { projectId, role: 'admin', scope: 'admin' });
    return this.page({ ...query, projectId });
  }

  private async page(filter: AuditEventFilter): Promise<AuditEventPage> {
    const cursor = filter.cursor && { id: filter.cursor, projectId: filter.projectId };
    if (cursor && !(await auditCursorExists(this.database, cursor)))
      notFound('AuditEvent cursor');
    // Fetch one extra row to know whether another page exists without a count query.
    const events = await listAuditEvents(this.database, { ...filter, limit: filter.limit + 1 });
    const items = events.slice(0, filter.limit);
    return { items, nextCursor: events.length > filter.limit ? items.at(-1)!.id : null };
  }
}
