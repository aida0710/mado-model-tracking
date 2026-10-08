import type { Run } from '@mmt/contracts';

/**
 * The server tag a Sweep puts on a trial it stopped early (apps/api sweepController). The trial's Run
 * ends as canceled, but the Sweep counts it as early_stopped, so screens show the Sweep's word.
 */
export const SWEEP_EARLY_STOPPED_TAG = 'mmt.sweepEarlyStopped';

export function isEarlyStoppedSweepTrial(run: Pick<Run, 'status' | 'tags'>): boolean {
  return run.status === 'canceled' && run.tags[SWEEP_EARLY_STOPPED_TAG] === 'true';
}
