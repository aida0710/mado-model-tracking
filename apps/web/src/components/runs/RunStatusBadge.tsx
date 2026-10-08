import type { Run } from '@mmt/contracts';
import { StatusBadge } from '../StatusBadge';
import { isSweepEarlyStoppedRun } from '../../lib/sweepEarlyStop';

/** A Run's status badge, naming early-stopped sweep trials the way the sweep page does. */
export function RunStatusBadge({ run }: { run: Pick<Run, 'status' | 'tags'> }) {
  return <StatusBadge status={run.status} earlyStopped={isSweepEarlyStoppedRun(run)} />;
}
