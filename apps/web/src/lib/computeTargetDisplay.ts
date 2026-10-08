import type { ComputeTarget, TargetCheckItemName } from '@mmt/contracts';
import { text } from '../i18n/catalog';
import { targetCheckItemLabels } from '../i18n/compute';

/**
 * Where a target runs Jobs, for the Compute table. A local target runs on the worker's own host,
 * so its stored host and port (127.0.0.1:22 from the form defaults) are not shown as SSH.
 */
export function formatTargetLocation(
  target: Pick<ComputeTarget, 'executor' | 'host' | 'port' | 'username'>,
): string {
  if (target.executor === 'local') return text.targetLocationLocal;
  return target.host ? `${target.username}@${target.host}:${target.port}` : '—';
}

/** How the worker reaches the target, as written above the connection check results. */
export function targetCheckHintFor(executor: ComputeTarget['executor']): string {
  return executor === 'local' ? text.targetCheckHintLocal : text.targetCheckHint;
}

/** The first check item is the SSH connection, or starting a command for a local target. */
export function targetCheckItemLabel(
  name: TargetCheckItemName,
  executor: ComputeTarget['executor'],
): string {
  if (name === 'connection' && executor === 'local') return text.targetCheckLocalConnection;
  return targetCheckItemLabels[name];
}
