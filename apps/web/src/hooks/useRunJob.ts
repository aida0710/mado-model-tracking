import type { Job } from '@mmt/contracts';
import { executionApi } from '../api/execution';
import { findRunJob } from '../lib/checkpointResume';
import { useQuery, type QueryState } from './useQuery';

/**
 * The Job that ran a Run, or null for a Run registered without one. The API has no Run-to-Job
 * lookup, so this searches the Project's jobs list; `enabled` keeps it off until it is needed.
 */
export function useRunJob({
  projectId,
  runId,
  enabled,
}: {
  projectId: string;
  runId: string;
  enabled: boolean;
}): QueryState<Job | null> {
  return useQuery(
    enabled ? `${projectId}:run-job:${runId}` : null,
    async (signal) => findRunJob(await executionApi.jobs(projectId, signal), runId) ?? null,
  );
}
