import type { ComputeTargetDetails } from '@mmt/contracts';
import { siteComputersApi } from '../api/siteComputers';
import { useQueryPolledWhileActive } from '../hooks/useQueryPolledWhileActive';
import { Resource } from './Feedback';
import { SiteConnectionChecks } from './SiteConnectionChecks';
import { SiteLoginKey } from './SiteLoginKey';
import { isKeyReady, isKeyRequested, sharedAccountKey } from '../lib/siteComputerDisplay';
import { text } from '../i18n/catalog';

/**
 * The shared account of an automatic site, for its owner and global administrators: the
 * launcher's public key to authorize on the account, its rotation, and the login checks.
 */
export function SiteSharedKeyPanel({
  target,
  userId,
}: {
  target: ComputeTargetDetails;
  userId: string;
}) {
  const keys = useQueryPolledWhileActive(
    `site-keys:${target.id}`,
    (signal) => siteComputersApi.keys(target.id, signal),
    (items) => isKeyRequested(sharedAccountKey(items)),
  );
  return (
    <section className="site-computer-section" aria-label={text.siteKeysTitle}>
      <h3>{text.siteKeysTitle}</h3>
      {!target.site?.launcherId && <p className="notice">{text.siteKeysNoLauncher}</p>}
      <Resource query={keys}>
        {(items) => (
          <SiteLoginKey
            targetId={target.id}
            siteKey={sharedAccountKey(items)}
            personal={false}
            accountName={target.site?.sharedAccount ?? ''}
            onRequested={keys.reload}
          />
        )}
      </Resource>
      <SiteConnectionChecks
        targetId={target.id}
        personal={false}
        userId={userId}
        isKeyReady={isKeyReady(sharedAccountKey(keys.value ?? []))}
      />
    </section>
  );
}
