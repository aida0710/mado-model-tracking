import type { Launcher } from '@mmt/contracts';
import { ResponsiveTable } from '../ResponsiveTable';
import { formatDate } from '../../lib/format';
import { text } from '../../i18n/catalog';

/** The launchers with their last answer and token prefix; revoked ones keep no actions. */
export function LaunchersTable({
  launchers,
  onRotateToken,
  onRevoke,
}: {
  launchers: Launcher[];
  onRotateToken: (launcher: Launcher) => void;
  onRevoke: (launcher: Launcher) => void;
}) {
  return (
    <ResponsiveTable
      rows={launchers}
      rowKey={(launcher) => launcher.id}
      label={text.launchers}
      empty={text.noLaunchers}
      columns={[
        { key: 'name', priority: 'primary', header: text.name, render: (launcher) => launcher.name },
        {
          key: 'status',
          priority: 'primary',
          header: text.launcherStatus,
          render: (launcher) =>
            launcher.revokedAt === null ? (
              <span className="status-badge status-finished">{text.launcherActive}</span>
            ) : (
              <span className="status-badge status-failed" title={formatDate(launcher.revokedAt)}>
                {text.launcherRevoked}
              </span>
            ),
        },
        {
          key: 'lastSeen',
          priority: 'secondary',
          header: text.launcherLastSeen,
          render: (launcher) =>
            launcher.lastSeenAt ? formatDate(launcher.lastSeenAt) : text.launcherNeverSeen,
        },
        {
          key: 'tokenPrefix',
          priority: 'secondary',
          header: text.launcherTokenPrefix,
          className: 'mono',
          render: (launcher) => (launcher.tokenPrefix ? `${launcher.tokenPrefix}…` : '—'),
        },
        {
          key: 'created',
          priority: 'secondary',
          header: text.launcherCreatedAt,
          render: (launcher) => formatDate(launcher.createdAt),
        },
        {
          key: 'actions',
          priority: 'secondary',
          header: text.actions,
          render: (launcher) =>
            launcher.revokedAt === null && (
              <div className="access-actions">
                <button className="button small" onClick={() => onRotateToken(launcher)}>
                  {text.launcherRotateToken}
                </button>
                <button className="button small danger" onClick={() => onRevoke(launcher)}>
                  {text.launcherRevoke}
                </button>
              </div>
            ),
        },
      ]}
    />
  );
}
