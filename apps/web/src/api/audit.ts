import type { AuditEvent } from '@mmt/contracts';
import { projectPath, request } from './http';
import { text } from '../i18n/catalog';

// Not in @mmt/contracts yet; the parent moves it there when merging this wave.
export interface AuditEventPage {
  items: AuditEvent[];
  nextCursor: string | null;
}

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
      throw new Error(text.invalidResponse);
    return page;
  },
};
