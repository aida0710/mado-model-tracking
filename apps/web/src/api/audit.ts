import type { AuditEventPage } from '@mmt/contracts';
import { invalidResponseError, projectPath, request } from './http';

// Matches the API default so each "load more" fetches one server page.
export const AUDIT_EVENT_PAGE_SIZE = 50;

export const auditApi = {
  projectEvents: async (
    projectId: string,
    { cursor, signal }: { cursor?: string; signal?: AbortSignal } = {},
  ): Promise<AuditEventPage> => {
    const query = new URLSearchParams({ limit: String(AUDIT_EVENT_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const page = await request<AuditEventPage>(`${projectPath(projectId)}/audit-events?${query}`, {
      signal,
    });
    if (
      !Array.isArray(page.items) ||
      (page.nextCursor !== null && typeof page.nextCursor !== 'string')
    )
      throw invalidResponseError();
    return page;
  },
};
