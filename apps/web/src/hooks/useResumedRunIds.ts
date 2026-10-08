import type { Job } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { collectResumedRunIds } from '../lib/checkpointResume';
import { useQuery, type QueryState } from './useQuery';

// One Run search page at the API maximum. A Job and its Run are created together, so the newest
// Runs cover the newest Jobs; a Job whose Run is older than this page shows no resume badge.
const RESUMED_RUN_SEARCH_LIMIT = 500;

/**
 * Ids of the Runs that continue from a checkpoint, for marking their Jobs. The Job carries no
 * checkpoint itself, so this reads the Run summaries and searches again only when a Job is added.
 */
export function useResumedRunIds(
  projectId: string,
  jobs: readonly Job[] | undefined,
): QueryState<Set<string>> {
  const newestJobId = jobs?.[0]?.id;
  return useQuery(
    jobs ? `${projectId}:resumed-runs:${jobs.length}:${newestJobId ?? ''}` : null,
    async (signal) => {
      const search = { limit: RESUMED_RUN_SEARCH_LIMIT };
      return collectResumedRunIds((await trackingApi.searchRuns(projectId, search, signal)).items);
    },
  );
}
