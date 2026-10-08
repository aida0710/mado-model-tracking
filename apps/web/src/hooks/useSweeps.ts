import { MAX_SERIES_RUNS, type Sweep, type SweepStatus, type SweepTrial } from '@mmt/contracts';
import { sweepsApi } from '../api/sweeps';
import { tasksApi } from '../api/tasks';
import { isSweepActive } from '../lib/sweepTrials';
import { useCursorPages } from './useCursorPages';
import { EXECUTION_POLL_MS, useQuery } from './useQuery';
import { useQueryPolledWhileActive } from './useQueryPolledWhileActive';

/** The Project's sweeps, newest first, narrowed by status and read page by page. */
export function useSweepList(projectId: string, status: SweepStatus | '') {
  return useCursorPages(`${projectId}:sweeps:${status}`, (cursor, signal) =>
    sweepsApi.list(projectId, { status: status || undefined, cursor, signal }),
  );
}

export interface SweepDetail {
  sweep: Sweep;
  trials: SweepTrial[];
}

/** A sweep and all of its trials, polled together while trials may still change. */
export function useSweepDetail(projectId: string, sweepId: string) {
  return useQueryPolledWhileActive<SweepDetail>(
    `${projectId}:sweep:${sweepId}`,
    async (signal) => {
      const [sweep, trials] = await Promise.all([
        sweepsApi.get(projectId, sweepId, signal),
        sweepsApi.allTrials(projectId, sweepId, signal),
      ]);
      return { sweep, trials };
    },
    (detail) => isSweepActive(detail.sweep),
  );
}

/**
 * The objective metric of the newest trial Runs, by step. The API takes MAX_SERIES_RUNS Runs per
 * request, so a larger sweep shows its newest trials. The key follows the trials' states so that
 * a newly finished trial is drawn without polling idle sweeps.
 */
export function useTrialObjectiveSeries(projectId: string, detail: SweepDetail | undefined) {
  const shownTrials = detail ? [...detail.trials].sort((left, right) => right.trialIndex - left.trialIndex).slice(0, MAX_SERIES_RUNS) : [];
  const stateKey = shownTrials.map((trial) => `${trial.trialIndex}:${trial.state}`).join(',');
  const isActive = detail ? isSweepActive(detail.sweep) : false;
  const series = useQuery(
    detail && shownTrials.length ? `${projectId}:sweep-series:${detail.sweep.id}:${stateKey}` : null,
    (signal) =>
      sweepsApi.objectiveSeries(projectId, {
        runIds: shownTrials.map((trial) => trial.runId),
        metric: detail!.sweep.objective.metric,
        signal,
      }),
    isActive ? EXECUTION_POLL_MS : undefined,
  );
  return { series, shownTrials, totalTrials: detail?.trials.length ?? 0 };
}

// Metric names come from the Task's newest Runs: one history page is enough to offer candidates.
export function useTaskMetricNames(projectId: string, taskId: string) {
  return useQuery(taskId ? `${projectId}:task-metric-names:${taskId}` : null, async (signal) => {
    const page = await tasksApi.runs(projectId, taskId, { signal });
    return [...new Set(page.items.flatMap((run) => Object.keys(run.latestMetrics)))].sort();
  });
}
