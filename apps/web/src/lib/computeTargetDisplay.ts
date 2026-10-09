import type { ComputeTarget, TargetCheckItemName } from '@mmt/contracts';
import { text } from '../i18n/catalog';
import {
  computeTargetExecutorLabels,
  submissionModeBadgeLabels,
  targetCheckItemLabels,
} from '../i18n/compute';

/**
 * Where a target runs Jobs, for the Compute table. A local target runs on the worker's own host,
 * so its stored host and port (127.0.0.1:22 from the form defaults) are not shown as SSH. A site's
 * connection lives in its launcher's settings, so tracking has no address to show.
 */
export function formatTargetLocation(
  target: Pick<ComputeTarget, 'executor' | 'host' | 'port' | 'username'>,
): string {
  if (target.executor === 'local') return text.targetLocationLocal;
  if (target.executor === 'site') return text.targetLocationSite;
  return target.host ? `${target.username}@${target.host}:${target.port}` : '—';
}

/** A target in a select: the name and where it runs. */
export function targetChoiceLabel(
  target: Pick<ComputeTarget, 'name' | 'executor' | 'host' | 'submissionMode'>,
): string {
  if (target.executor !== 'site') return `${target.name} · ${target.host}`;
  const mode = submissionModeBadgeLabels[target.submissionMode];
  return `${target.name} · ${computeTargetExecutorLabels.site}（${mode}）`;
}

/** The GPUs a target offers: its GPU IDs, or for a site the count each Job asks for. */
export function formatTargetGpus(target: Pick<ComputeTarget, 'executor' | 'gpuIds'>): string {
  if (target.executor === 'site') return text.targetGpuPerJob;
  return target.gpuIds.join(', ') || text.cpuOnly;
}

/** How the worker reaches the target, as written above the connection check results. */
export function targetCheckHintFor(executor: ComputeTarget['executor']): string {
  if (executor === 'site') return text.targetCheckSite;
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
