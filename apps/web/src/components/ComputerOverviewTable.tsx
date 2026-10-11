import type { ComputeTargetOverview, User } from '@mmt/contracts';
import { ResponsiveTable } from './ResponsiveTable';
import { ComputeTargetKind } from './ComputeTargetKind';
import { ComputeTargetState } from './ComputeTargetState';
import { VisibilityLabel } from './VisibilityLabel';
import { canOpenTargetDetails, launcherStatusLabel } from '../lib/computeTargetOverview';
import { targetOwnerLabel } from '../lib/siteComputerDisplay';
import { text } from '../i18n/catalog';

/**
 * Every computer in 全体設定 → コンピュータ. A row one may use or manage opens its details; its
 * owner and global administrators also edit it, switch it on or off and check an ssh or local one.
 * Someone else's private computer is only its name, kind, owner, visibility and state.
 */
export function ComputerOverviewTable({
  targets,
  user,
  selectedTargetId,
  pending,
  onOpen,
  onEdit,
  onToggleEnabled,
}: {
  targets: ComputeTargetOverview[];
  user: Pick<User, 'id'>;
  selectedTargetId: string | null;
  /** A change is being saved; the switches wait for it. */
  pending: boolean;
  /** Opens the details below the list: a site's details, or an ssh or local target's check. */
  onOpen: (target: ComputeTargetOverview) => void;
  onEdit: (target: ComputeTargetOverview) => void;
  onToggleEnabled: (target: ComputeTargetOverview) => void;
}) {
  return (
    <ResponsiveTable
      rows={targets}
      rowKey={(target) => target.id}
      selectedKey={selectedTargetId ?? undefined}
      empty={text.noComputers}
      columns={[
        {
          key: 'name',
          priority: 'primary',
          header: text.name,
          render: (target) =>
            canOpenTargetDetails(target) ? (
              <button
                className="link-button"
                data-testid={`target-details-${target.id}`}
                onClick={() => onOpen(target)}
              >
                {target.name}
              </button>
            ) : (
              target.name
            ),
        },
        {
          key: 'kind',
          priority: 'secondary',
          header: text.computerKind,
          render: (target) => <ComputeTargetKind target={target} />,
        },
        {
          key: 'owner',
          priority: 'secondary',
          header: text.computerOwner,
          render: (target) => targetOwnerLabel(target, user.id),
        },
        {
          key: 'visibility',
          priority: 'primary',
          header: text.computerVisibility,
          render: (target) => <VisibilityLabel visibility={target.visibility} />,
        },
        {
          key: 'state',
          priority: 'secondary',
          header: text.computerState,
          render: (target) => (
            <ComputeTargetState
              enabled={target.enabled}
              launcherStatus={launcherStatusLabel(target)}
            />
          ),
        },
        {
          key: 'usable',
          priority: 'secondary',
          header: text.computerUsable,
          render: (target) => (target.usable ? text.computerUsableYes : text.computerUsableNo),
        },
        ...(targets.some((target) => target.canManage)
          ? [
              {
                key: 'actions',
                priority: 'secondary' as const,
                header: text.actions,
                render: (target: ComputeTargetOverview) =>
                  target.canManage && (
                    <div className="access-actions">
                      <button
                        className="button small"
                        data-testid={`target-edit-${target.id}`}
                        onClick={() => onEdit(target)}
                      >
                        {text.editTarget}
                      </button>
                      <button
                        className="button small"
                        data-testid={`target-toggle-${target.id}`}
                        disabled={pending}
                        onClick={() => onToggleEnabled(target)}
                      >
                        {target.enabled ? text.computerDisable : text.computerEnable}
                      </button>
                      {/* A site's launcher checks its login in the site's details instead. */}
                      {target.executor !== 'site' && (
                        <button
                          className="button small"
                          data-testid={`target-check-${target.id}`}
                          onClick={() => onOpen(target)}
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
