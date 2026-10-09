import type { ComputeTarget } from '@mmt/contracts';
import { ResponsiveTable } from './ResponsiveTable';
import { formatTargetGpus, formatTargetLocation } from '../lib/computeTargetDisplay';
import { text } from '../i18n/catalog';
import { computeTargetExecutorLabels, submissionModeBadgeLabels } from '../i18n/compute';
import { runtimeLabels } from '../i18n/runtime';

const toggleLabel = (target: ComputeTarget) =>
  target.enabled ? text.disableTarget : text.enableTarget;

/** The executor with the CPU, and for a site how it is submitted and whether it takes arrays. */
function TargetKind({ target }: { target: ComputeTarget }) {
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

/** Compute targets of the Compute page. Only global administrators get the editing controls. */
export function ComputeTargetsTable({
  targets,
  canManage,
  pending,
  onToggleEnabled,
  onEdit,
  onCheck,
}: {
  targets: ComputeTarget[];
  canManage: boolean;
  /** A change is being saved; the enabled switches wait for it. */
  pending: boolean;
  onToggleEnabled: (target: ComputeTarget) => void;
  onEdit: (target: ComputeTarget) => void;
  onCheck: (target: ComputeTarget) => void;
}) {
  return (
    <ResponsiveTable
      rows={targets}
      rowKey={(target) => target.id}
      empty={text.noTargets}
      columns={[
        { key: 'name', priority: 'primary', header: text.name, render: (target) => target.name },
        {
          key: 'host',
          priority: 'secondary',
          header: text.host,
          className: 'mono',
          render: (target) => formatTargetLocation(target),
        },
        {
          key: 'executor',
          priority: 'secondary',
          header: text.executor,
          render: (target) => <TargetKind target={target} />,
        },
        {
          key: 'runtime',
          priority: 'secondary',
          header: text.runtimeKinds,
          render: (target) => target.runtimeKinds.map((kind) => runtimeLabels[kind]).join(', '),
        },
        {
          key: 'gpu',
          priority: 'secondary',
          header: text.gpuIds,
          className: 'mono',
          render: (target) => formatTargetGpus(target),
        },
        {
          key: 'concurrent',
          priority: 'secondary',
          header: text.maxConcurrentJobs,
          className: 'mono',
          render: (target) => target.maxConcurrentJobs,
        },
        {
          key: 'enabled',
          priority: 'primary',
          header: text.enabled,
          render: (target) => (
            <label className="table-checkbox">
              <input
                type="checkbox"
                checked={target.enabled}
                disabled={!canManage || pending}
                aria-label={`${toggleLabel(target)}: ${target.name}`}
                onChange={() => onToggleEnabled(target)}
              />
            </label>
          ),
        },
        ...(canManage
          ? [
              {
                key: 'actions',
                priority: 'secondary' as const,
                header: text.actions,
                render: (target: ComputeTarget) => (
                  <div className="access-actions">
                    <button
                      className="button small"
                      data-testid={`target-edit-${target.id}`}
                      onClick={() => onEdit(target)}
                    >
                      {text.editTarget}
                    </button>
                    {/* The panel of a site explains that its launcher, not a worker, reaches it. */}
                    <button
                      className="button small"
                      data-testid={`target-check-${target.id}`}
                      onClick={() => onCheck(target)}
                    >
                      {text.checkTarget}
                    </button>
                  </div>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
