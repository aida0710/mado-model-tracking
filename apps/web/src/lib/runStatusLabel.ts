import type { Run } from '@mmt/contracts';
import { SWEEP_EARLY_STOPPED_TAG } from './sweepRunTags';
import { text } from '../i18n/catalog';

export const isEarlyStoppedTrial = (run: Pick<Run, 'status' | 'tags'>) =>
  run.status === 'canceled' && run.tags[SWEEP_EARLY_STOPPED_TAG] === 'true';

/** The status shown for a Run: an early-stopped sweep trial reads as such, not as canceled. */
export const runStatusLabel = (run: Pick<Run, 'status' | 'tags'>) =>
  isEarlyStoppedTrial(run) ? text.earlyStopped : text[run.status];
