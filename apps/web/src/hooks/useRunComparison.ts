import { useEffect, useState } from 'react';
import type { RunComparison, RunStatus } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { isComparableRunCount } from '../lib/comparisonRows';
import { EXECUTION_POLL_MS, useQuery, type QueryState } from './useQuery';

const activeStatuses: readonly RunStatus[] = ['queued', 'running'];

/**
 * The comparison of the Runs from one API call, with their downsampled metric history. It is
 * refreshed while any compared Run can still change and stops once all have ended.
 */
export function useRunComparison(comparison: {
  projectId: string;
  runIds: string[];
  baselineRunId: string | null;
}): QueryState<RunComparison> {
  const { projectId, runIds, baselineRunId } = comparison;
  const key = isComparableRunCount(runIds.length)
    ? `${projectId}:run-comparison:${runIds.join(',')}:${baselineRunId ?? ''}`
    : null;
  const loader = (signal: AbortSignal) =>
    trackingApi.compareRuns(
      projectId,
      {
        runIds,
        ...(baselineRunId ? { baselineRunId } : {}),
        includeHistory: true,
      },
      signal,
    );
  const [pollMs, setPollMs] = useState<number | undefined>(EXECUTION_POLL_MS);
  const query = useQuery(key, loader, pollMs);
  // Decided only from a response, so a reload for another baseline keeps the current interval.
  const hasActiveRuns = query.value
    ? query.value.runs.some((run) => activeStatuses.includes(run.status))
    : null;
  useEffect(() => {
    if (hasActiveRuns !== null) setPollMs(hasActiveRuns ? EXECUTION_POLL_MS : undefined);
  }, [hasActiveRuns]);
  return query;
}
