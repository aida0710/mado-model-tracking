import type { RunCheckpointPage } from '@mmt/contracts';
import { executionApi } from '../api/execution';
import { EXECUTION_POLL_MS, useQuery, type QueryState } from './useQuery';

/** A Run's checkpoints, refreshed while training may still be saving new ones. */
export function useRunCheckpoints({
  projectId,
  runId,
  includeHidden,
}: {
  projectId: string;
  runId: string;
  includeHidden: boolean;
}): QueryState<RunCheckpointPage> {
  return useQuery(
    `${projectId}:${runId}:checkpoints:${includeHidden ? 'all' : 'retained'}`,
    (signal) => executionApi.listRunCheckpoints(projectId, runId, { includeHidden }, signal),
    EXECUTION_POLL_MS,
  );
}
