import type { MediaCompareGrid, Run, RunMediaKeySummary } from '@mmt/contracts';
import { runMediaApi } from '../api/runMedia';
import { trackingApi } from '../api/tracking';
import { sortedSteps } from '../lib/mediaSteps';
import { useQuery, type QueryState } from './useQuery';

export interface MediaCompareChoices {
  runs: Run[];
  /** Keys recorded by at least one compared Run, by name. */
  keys: RunMediaKeySummary[];
}

/** Merges each Run's key summaries into one entry per key (counts summed, step range widened). */
function mergeKeySummaries(summariesByRun: RunMediaKeySummary[][]): RunMediaKeySummary[] {
  const merged = new Map<string, RunMediaKeySummary>();
  for (const summary of summariesByRun.flat()) {
    const existing = merged.get(summary.key);
    merged.set(
      summary.key,
      existing
        ? {
            ...existing,
            count: existing.count + summary.count,
            minStep: Math.min(existing.minStep, summary.minStep),
            maxStep: Math.max(existing.maxStep, summary.maxStep),
          }
        : summary,
    );
  }
  return [...merged.values()].sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Data for comparing one media key across Runs: the Runs and keys to choose from, every step any
 * Run recorded for the selected key (the chosen one, or the first), and the Run × step grid from
 * POST /media/compare. An empty `steps` asks the API for each Run's latest step.
 */
export function useMediaCompare({
  projectId,
  runIds,
  chosenKey,
  steps,
}: {
  projectId: string;
  runIds: string[];
  chosenKey: string | null;
  steps: number[];
}): {
  choices: QueryState<MediaCompareChoices>;
  selectedKey: string | null;
  recordedSteps: QueryState<number[]>;
  grid: QueryState<MediaCompareGrid>;
} {
  const runKey = runIds.join(',');
  const choices = useQuery(`${projectId}:media-compare-choices:${runKey}`, async (signal) => {
    const [runs, summaries] = await Promise.all([
      Promise.all(runIds.map((runId) => trackingApi.run(projectId, runId, signal))),
      Promise.all(runIds.map((runId) => runMediaApi.keys(projectId, runId, signal))),
    ]);
    return { runs, keys: mergeKeySummaries(summaries) };
  });
  const key = chosenKey ?? choices.value?.keys[0]?.key ?? null;
  const recordedSteps = useQuery(key === null ? null : `${projectId}:media-compare-steps:${runKey}:${key}`, async (signal) => {
    const lists = await Promise.all(runIds.map((runId) => runMediaApi.list(projectId, runId, { key: key! }, signal)));
    return sortedSteps(lists.flatMap((list) => list.items.map((item) => item.step)));
  });
  const grid = useQuery(key === null ? null : `${projectId}:media-compare:${runKey}:${key}:${steps.join(',')}`, (signal) =>
    runMediaApi.compare(projectId, { runIds, key: key!, ...(steps.length > 0 ? { steps } : {}) }, signal),
  );
  return { choices, selectedKey: key, recordedSteps, grid };
}
