import type { Run } from '@mmt/contracts';

// The API tags a Sweep trial's Run when Hyperband stops it (sweepController
// SWEEP_EARLY_STOPPED_TAG). The Run itself ends as canceled, the same as a cancel by a person.
export const SWEEP_EARLY_STOPPED_TAG = 'mmt.sweepEarlyStopped';

export function isSweepEarlyStoppedRun(run: Pick<Run, 'status' | 'tags'>): boolean {
  return run.status === 'canceled' && run.tags[SWEEP_EARLY_STOPPED_TAG] === 'true';
}
