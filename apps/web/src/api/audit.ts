import type { AuditEventPage } from '@mmt/contracts';
import { invalidResponseError, projectPath, request } from './http';

// Matches the API default so each "load more" fetches one server page.
export const AUDIT_EVENT_PAGE_SIZE = 50;

export interface AuditPageRequest {
  cursor?: string;
  signal?: AbortSignal;
}

async function fetchAuditPage(
  path: string,
  { cursor, signal }: AuditPageRequest,
): Promise<AuditEventPage> {
  const query = new URLSearchParams({ limit: String(AUDIT_EVENT_PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);
  const page = await request<AuditEventPage>(`${path}?${query}`, { signal });
  if (
    !Array.isArray(page.items) ||
    (page.nextCursor !== null && typeof page.nextCursor !== 'string')
  )
    throw invalidResponseError();
  return page;
}

export const auditApi = {
  projectEvents: (projectId: string, page: AuditPageRequest = {}) =>
    fetchAuditPage(`${projectPath(projectId)}/audit-events`, page),
  // Global administrators only; includes events of no Project (logins, users, storage).
  globalEvents: (page: AuditPageRequest = {}) => fetchAuditPage('/audit-events', page),
};
