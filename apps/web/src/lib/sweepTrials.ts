import type { Sweep, SweepObjective, SweepStatus, SweepTrial } from '@mmt/contracts';

// Values the Sweep detail derives from its trials: the progress chart, the trial order and
// whether the page still needs polling. Kept apart from the components so they can be tested.

const ENDED_STATUSES: readonly SweepStatus[] = ['finished', 'canceled', 'failed'];

/** finished, canceled and failed sweeps accept no pause/resume/cancel/limits change (409 sweep_finished). */
export function isSweepEnded(sweep: Pick<Sweep, 'status'>): boolean {
  return ENDED_STATUSES.includes(sweep.status);
}

/** A sweep keeps changing while it may queue trials or still has trials in flight. */
export function isSweepActive(sweep: Pick<Sweep, 'status' | 'trialCounts'>): boolean {
  return sweep.status === 'running' || sweep.trialCounts.queued + sweep.trialCounts.running > 0;
}

const isBetter = (goal: SweepObjective['goal'], candidate: number, current: number) =>
  goal === 'minimize' ? candidate < current : candidate > current;

export interface ObjectiveProgressPoint {
  trialIndex: number;
  objective: number;
  /** The best objective among this and earlier trials; null until a trial can count as best. */
  bestSoFar: number | null;
}

/**
 * Trials with an objective in trial order. Only finished and early_stopped trials count toward
 * the best, matching the API's bestTrial; failed or canceled values were cut off midway.
 */
export function objectiveProgress(trials: SweepTrial[], goal: SweepObjective['goal']): ObjectiveProgressPoint[] {
  const points: ObjectiveProgressPoint[] = [];
  let best: number | null = null;
  for (const trial of [...trials].sort((left, right) => left.trialIndex - right.trialIndex)) {
    if (trial.objectiveValue === null) continue;
    if ((trial.state === 'finished' || trial.state === 'early_stopped') && (best === null || isBetter(goal, trial.objectiveValue, best)))
      best = trial.objectiveValue;
    points.push({ trialIndex: trial.trialIndex, objective: trial.objectiveValue, bestSoFar: best });
  }
  return points;
}

export type SweepTrialOrder = 'trial_index' | 'objective';

/** The API's orderBy rules: objective is best first by the goal, trials without one last. */
export function sortTrials(trials: SweepTrial[], order: SweepTrialOrder, goal: SweepObjective['goal']): SweepTrial[] {
  return [...trials].sort((left, right) => {
    if (order === 'objective') {
      if (left.objectiveValue !== right.objectiveValue) {
        if (left.objectiveValue === null) return 1;
        if (right.objectiveValue === null) return -1;
        return goal === 'minimize' ? left.objectiveValue - right.objectiveValue : right.objectiveValue - left.objectiveValue;
      }
    }
    return left.trialIndex - right.trialIndex;
  });
}

/** Parameter names across trials in name order, for the trial table's columns. */
export function trialParameterNames(trials: SweepTrial[]): string[] {
  return [...new Set(trials.flatMap((trial) => Object.keys(trial.parameters)))].sort();
}
