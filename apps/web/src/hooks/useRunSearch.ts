import type { RunSearchPage, RunSearchRequest } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { EXECUTION_POLL_MS, useQuery, type QueryState } from './useQuery';

/** One page of the server-side Run search, refreshed while Runs are executing. */
export function useRunSearch(
  projectId: string,
  search: RunSearchRequest,
): QueryState<RunSearchPage> {
  return useQuery(
    `${projectId}:run-search:${JSON.stringify(search)}`,
    (signal) => trackingApi.searchRuns(projectId, search, signal),
    EXECUTION_POLL_MS,
  );
}
