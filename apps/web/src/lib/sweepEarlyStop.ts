import type { Run } from '@mmt/contracts';
import { SWEEP_EARLY_STOPPED_TAG } from './sweepRunTags';

/** A trial the Sweep stopped early; its Run ends canceled, the same as a cancel by a person. */
export function isSweepEarlyStoppedRun(run: Pick<Run, 'status' | 'tags'>): boolean {
  return run.status === 'canceled' && run.tags[SWEEP_EARLY_STOPPED_TAG] === 'true';
}
