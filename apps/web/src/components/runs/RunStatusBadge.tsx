import type { Run } from '@mmt/contracts';
import { isEarlyStoppedSweepTrial } from '../../lib/runStatusDisplay';
import { StatusBadge } from '../StatusBadge';
import { sweepTrialStateLabels } from '../../i18n/sweeps';

/** A Run's status, naming a Sweep's early-stopped trial as the Sweep does instead of canceled. */
export function RunStatusBadge({ run }: { run: Pick<Run, 'status' | 'tags'> }) {
  if (!isEarlyStoppedSweepTrial(run)) return <StatusBadge status={run.status} />;
  return <StatusBadge status={run.status} label={sweepTrialStateLabels.early_stopped} />;
}
