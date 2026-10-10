import { PlugZap } from 'lucide-react';
import type { SiteConnectionCheck, SiteConnectionCheckStatus } from '@mmt/contracts';
import { siteComputersApi } from '../api/siteComputers';
import { useMutation } from '../hooks/useMutation';
import { useQueryPolledWhileActive } from '../hooks/useQueryPolledWhileActive';
import { ErrorNotice, Resource } from './Feedback';
import { ResponsiveTable } from './ResponsiveTable';
import { formatDate } from '../lib/format';
import { isConnectionCheckInProgress } from '../lib/siteComputerDisplay';
import { text } from '../i18n/catalog';
import { siteConnectionCheckStatusLabels } from '../i18n/siteComputers';

// Reuses the Job status colors: succeeded is green, failed red, a waiting check neutral.
const checkBadgeClass: Record<SiteConnectionCheckStatus, string> = {
  queued: 'status-queued',
  succeeded: 'status-finished',
  failed: 'status-failed',
};

/**
 * Asks the launcher to log in once with the key and account (one's own, or the shared account's)
 * and lists the newest results, polling while the newest one waits for the launcher. A check
 * needs the key the launcher made, so it waits for that key.
 */
export function SiteConnectionChecks({
  targetId,
  personal,
  userId,
  isKeyReady,
}: {
  targetId: string;
  personal: boolean;
  userId: string;
  /** The launcher has made the account's key; until then the API refuses a check. */
  isKeyReady: boolean;
}) {
  const mutation = useMutation();
  // A global administrator may be sent other people's checks too; only this account's are shown.
  const accountChecks = (checks: SiteConnectionCheck[]) =>
    checks.filter((check) => check.userId === (personal ? userId : null));
  const checks = useQueryPolledWhileActive(
    `site-connection-checks:${targetId}:${personal}`,
    (signal) => siteComputersApi.connectionChecks(targetId, personal, signal),
    (items) => isConnectionCheckInProgress(accountChecks(items)),
  );
  const isInProgress = isConnectionCheckInProgress(accountChecks(checks.value ?? []));
  const requestCheck = () =>
    void mutation
      .run(() => siteComputersApi.requestConnectionCheck(targetId, { personal }))
      .then((created) => {
        if (created) checks.reload();
      });
  return (
    <div className="site-connection-checks">
      <p className="muted">{text.siteConnectionCheckHint}</p>
      <div className="site-computer-actions">
        <button
          type="button"
          className="button small"
          disabled={mutation.pending || isInProgress || !isKeyReady}
          onClick={requestCheck}
        >
          <PlugZap size={14} />
          {text.checkTarget}
        </button>
      </div>
      <ErrorNotice message={mutation.error} />
      <Resource query={checks}>
        {(items) => <SiteConnectionCheckList checks={accountChecks(items)} />}
      </Resource>
    </div>
  );
}

export function SiteConnectionCheckList({ checks }: { checks: SiteConnectionCheck[] }) {
  return (
    <ResponsiveTable
      rows={checks}
      rowKey={(check) => check.id}
      label={text.siteConnectionChecks}
      empty={text.siteConnectionCheckNone}
      columns={[
        {
          key: 'status',
          priority: 'primary',
          header: text.status,
          render: (check) => (
            <span className={`status-badge ${checkBadgeClass[check.status]}`}>
              <span aria-hidden="true">●</span>
              {siteConnectionCheckStatusLabels[check.status]}
            </span>
          ),
        },
        {
          key: 'message',
          priority: 'primary',
          header: text.siteConnectionCheckMessage,
          className: 'mono',
          render: (check) => check.message ?? '—',
        },
        {
          key: 'requested',
          priority: 'secondary',
          header: text.targetCheckRequestedAt,
          render: (check) => formatDate(check.createdAt),
        },
        {
          key: 'finished',
          priority: 'secondary',
          header: text.targetCheckFinishedAt,
          render: (check) => formatDate(check.finishedAt),
        },
      ]}
    />
  );
}
