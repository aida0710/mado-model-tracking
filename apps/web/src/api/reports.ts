import type {
  ReportCreate,
  ReportDocument,
  ReportPage,
  ReportRestore,
  ReportRevisionList,
  ReportSnapshotList,
  ReportUpdate,
  SavedView,
} from '@mmt/contracts';
import { assertCursorPage, encodeId, invalidResponseError, jsonRequest, projectPath, request, RequestError } from './http';

/** The API's answer when the edit started from a revision that is no longer current. */
export const REPORT_REVISION_CONFLICT_CODE = 'report_revision_conflict';

export function isReportRevisionConflict(failure: unknown): boolean {
  return failure instanceof RequestError && failure.status === 409 && failure.code === REPORT_REVISION_CONFLICT_CODE;
}

const reportsPath = (projectId: string) => `${projectPath(projectId)}/reports`;
const reportPath = (projectId: string, reportId: string) => `${reportsPath(projectId)}/${encodeId(reportId)}`;

function assertDocument(document: ReportDocument): ReportDocument {
  if (
    typeof document.report?.id !== 'string' ||
    typeof document.revision?.revision !== 'number' ||
    !Array.isArray(document.revision.blocks)
  )
    throw invalidResponseError();
  return document;
}

export const reportsApi = {
  list: async (
    projectId: string,
    { includeArchived, cursor, signal }: { includeArchived: boolean; cursor?: string; signal?: AbortSignal },
  ) => {
    const query = new URLSearchParams();
    if (includeArchived) query.set('includeArchived', 'true');
    if (cursor) query.set('cursor', cursor);
    const search = query.toString();
    const page = await request<ReportPage>(`${reportsPath(projectId)}${search ? `?${search}` : ''}`, { signal });
    assertCursorPage(page);
    return page;
  },
  /** The current revision, or the given one (read-only history). */
  get: async (projectId: string, reportId: string, { revision, signal }: { revision?: number; signal?: AbortSignal } = {}) =>
    assertDocument(
      await request<ReportDocument>(
        `${reportPath(projectId, reportId)}${revision === undefined ? '' : `?revision=${revision}`}`,
        { signal },
      ),
    ),
  revisions: async (projectId: string, reportId: string, signal?: AbortSignal) => {
    const list = await request<ReportRevisionList>(`${reportPath(projectId, reportId)}/revisions`, { signal });
    if (!Array.isArray(list.items)) throw invalidResponseError();
    return list.items;
  },
  snapshots: async (projectId: string, reportId: string, revision: number, signal?: AbortSignal) => {
    const list = await request<ReportSnapshotList>(
      `${reportPath(projectId, reportId)}/snapshots?revision=${revision}`,
      { signal },
    );
    if (!Array.isArray(list.items)) throw invalidResponseError();
    return list.items;
  },
  create: async (projectId: string, input: ReportCreate) =>
    assertDocument(await request<ReportDocument>(reportsPath(projectId), jsonRequest('POST', input))),
  /** Rejects with 409 report_revision_conflict (isReportRevisionConflict) instead of overwriting. */
  update: async (projectId: string, reportId: string, input: ReportUpdate) =>
    assertDocument(await request<ReportDocument>(reportPath(projectId, reportId), jsonRequest('PUT', input))),
  restore: async (projectId: string, reportId: string, input: ReportRestore) =>
    assertDocument(
      await request<ReportDocument>(`${reportPath(projectId, reportId)}/restore`, jsonRequest('POST', input)),
    ),
  archive: (projectId: string, reportId: string) =>
    request<unknown>(`${reportPath(projectId, reportId)}/archive`, { method: 'POST' }),
  unarchive: (projectId: string, reportId: string) =>
    request<unknown>(`${reportPath(projectId, reportId)}/unarchive`, { method: 'POST' }),
  /**
   * Saved Run list views a report may embed. A private view is left out: other readers of the
   * report could not open it, so the API rejects it.
   */
  shareableSavedViews: async (projectId: string, signal?: AbortSignal) => {
    const list = await request<{ items: SavedView[] }>(`${projectPath(projectId)}/saved-views?page=runs`, { signal });
    if (!Array.isArray(list.items)) throw invalidResponseError();
    return list.items.filter((view) => view.visibility === 'project');
  },
  savedView: (projectId: string, savedViewId: string, signal?: AbortSignal) =>
    request<SavedView>(`${projectPath(projectId)}/saved-views/${encodeId(savedViewId)}`, { signal }),
};
