import type { ComputeTarget } from '@mmt/contracts';
import { text } from '../i18n/catalog';
import { computeTargetExecutorLabels, submissionModeBadgeLabels } from '../i18n/compute';

/** The executor with the CPU, and for a site how it is submitted and whether it takes arrays. */
export function ComputeTargetKind({
  target,
}: {
  target: Pick<ComputeTarget, 'executor' | 'cpuArch' | 'submissionMode' | 'supportsArray'>;
}) {
  return (
    <span className="badge-group">
      {computeTargetExecutorLabels[target.executor]}
      <span className="status-badge status-queued">{target.cpuArch}</span>
      {target.executor === 'site' && (
        <span
          className={`status-badge ${target.submissionMode === 'manual' ? 'status-attention' : 'status-queued'}`}
        >
          {submissionModeBadgeLabels[target.submissionMode]}
        </span>
      )}
      {target.executor === 'site' && target.supportsArray && (
        <span className="status-badge status-queued">{text.supportsArrayBadge}</span>
      )}
    </span>
  );
}
