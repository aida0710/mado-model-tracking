import type { ComputeTargetDetails, Project, User } from '@mmt/contracts';
import { ResponsiveTable } from './ResponsiveTable';
import { formatTargetGpus, formatTargetLocation } from '../lib/computeTargetDisplay';
import { targetOwnerLabel, targetSharingLabel } from '../lib/siteComputerDisplay';
import { canManageTarget } from '../lib/permissions';
import { text } from '../i18n/catalog';
import { computeTargetExecutorLabels, submissionModeBadgeLabels } from '../i18n/compute';
import { runtimeLabels } from '../i18n/runtime';

const NOT_SHOWN = '—';

const toggleLabel = (target: ComputeTargetDetails) =>
  target.enabled ? text.disableTarget : text.enableTarget;

/** The executor with the CPU, and for a site how it is submitted and whether it takes arrays. */
function TargetKind({ target }: { target: ComputeTargetDetails }) {
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

/**
 * The computers of the Compute page with whose they are and where they are shared. A site's name
 * opens its details for everyone who sees it (job shell, own settings, submission); its owner and
 * global administrators also edit it, and global administrators check ssh and local targets.
 */
export function ComputeTargetsTable({
  targets,
  user,
  projects,
  selectedTargetId,
  pending,
  onSelect,
  onToggleEnabled,
  onEdit,
}: {
  targets: ComputeTargetDetails[];
  user: Pick<User, 'id' | 'isAdmin'>;
  /** Names for the Projects a computer is shared with. */
  projects: ReadonlyArray<Pick<Project, 'id' | 'name'>>;
  selectedTargetId: string | null;
  /** A change is being saved; the enabled switches wait for it. */
  pending: boolean;
  /** Opens the details below the list: a site's details, or an ssh or local target's check. */
  onSelect: (target: ComputeTargetDetails) => void;
  onToggleEnabled: (target: ComputeTargetDetails) => void;
  onEdit: (target: ComputeTargetDetails) => void;
}) {
  const canManage = (target: ComputeTargetDetails) => canManageTarget(user, target);
  const hasDetails = (target: ComputeTargetDetails) =>
    target.executor === 'site' || canManage(target);
  return (
    <ResponsiveTable
      rows={targets}
      rowKey={(target) => target.id}
      selectedKey={selectedTargetId ?? undefined}
      empty={text.noTargets}
      columns={[
        {
          key: 'name',
          priority: 'primary',
          header: text.name,
          render: (target) =>
            hasDetails(target) ? (
              <button
                className="link-button"
                data-testid={`target-details-${target.id}`}
                onClick={() => onSelect(target)}
              >
                {target.name}
              </button>
            ) : (
              target.name
            ),
        },
        {
          key: 'owner',
          priority: 'secondary',
          header: text.targetOwner,
          render: (target) => targetOwnerLabel(target, user.id),
        },
        {
          key: 'sharing',
          priority: 'secondary',
          header: text.targetSharing,
          render: (target) => targetSharingLabel(target, projects, canManage(target)) ?? NOT_SHOWN,
        },
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
                disabled={!canManage(target) || pending}
                aria-label={`${toggleLabel(target)}: ${target.name}`}
                onChange={() => onToggleEnabled(target)}
              />
            </label>
          ),
        },
        ...(targets.some(canManage)
          ? [
              {
                key: 'actions',
                priority: 'secondary' as const,
                header: text.actions,
                render: (target: ComputeTargetDetails) =>
                  canManage(target) && (
                    <div className="access-actions">
                      <button
                        className="button small"
                        data-testid={`target-edit-${target.id}`}
                        onClick={() => onEdit(target)}
                      >
                        {text.editTarget}
                      </button>
                      {/* A site's launcher checks its login in the site's details instead. */}
                      {target.executor !== 'site' && (
                        <button
                          className="button small"
                          data-testid={`target-check-${target.id}`}
                          onClick={() => onSelect(target)}
                        >
                          {text.checkTarget}
                        </button>
                      )}
                    </div>
                  ),
              },
            ]
          : []),
      ]}
    />
  );
}
