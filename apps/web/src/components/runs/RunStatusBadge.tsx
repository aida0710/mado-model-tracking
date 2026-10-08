import type { Run } from '@mmt/contracts';
import { StatusBadge } from '../StatusBadge';
import { runStatusLabel } from '../../lib/runStatusLabel';

/** A Run's status badge, naming early-stopped sweep trials the way the sweep page does. */
export function RunStatusBadge({ run }: { run: Pick<Run, 'status' | 'tags'> }) {
  return <StatusBadge status={run.status} label={runStatusLabel(run)} />;
}
