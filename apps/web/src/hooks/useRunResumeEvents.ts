import type { RunStatus } from '@mmt/contracts';
import { runResumeApi } from '../api/runResume';
import { EXECUTION_POLL_MS, useQuery } from './useQuery';

/** Polls while the Run runs, since a running Run can end and be resumed again. */
export function useRunResumeEvents(projectId: string, runId: string, status: RunStatus | undefined) {
  return useQuery(
    runId ? `${projectId}:run:${runId}:resume-events` : null,
    (signal) => runResumeApi.events(projectId, runId, signal),
    status === 'running' ? EXECUTION_POLL_MS : undefined,
  );
}
