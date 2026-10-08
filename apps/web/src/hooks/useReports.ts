import { reportsApi } from '../api/reports';
import { useCursorPages } from './useCursorPages';

/** The Project's reports, newest update first, read page by page; archived ones on request. */
export function useReportList(projectId: string, includeArchived: boolean) {
  return useCursorPages(`${projectId}:reports:${includeArchived}`, (cursor, signal) =>
    reportsApi.list(projectId, { includeArchived, cursor, signal }),
  );
}
