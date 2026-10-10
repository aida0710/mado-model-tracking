import { RefreshCw } from 'lucide-react';
import type { SitePersonalSettings } from '@mmt/contracts';
import { siteComputersApi } from '../api/siteComputers';
import { useQuery } from '../hooks/useQuery';
import { Resource } from './Feedback';
import { ResponsiveTable } from './ResponsiveTable';
import { formatDate } from '../lib/format';
import { formatSiteVariables } from '../lib/siteVariables';
import { text } from '../i18n/catalog';
import { siteKeyStatusLabels } from '../i18n/siteComputers';

const NOT_SET = '—';

/** Everyone's settings for a site, for its owner and global administrators. */
export function SitePersonalSettingsTable({ targetId }: { targetId: string }) {
  const settings = useQuery(`site-personal-settings-list:${targetId}`, (signal) =>
    siteComputersApi.personalSettings(targetId, signal),
  );
  return (
    <section className="site-computer-section" aria-label={text.sitePersonalListTitle}>
      <div className="section-heading">
        <h3>{text.sitePersonalListTitle}</h3>
        <button className="icon-button" aria-label={text.refresh} onClick={settings.reload}>
          <RefreshCw size={16} />
        </button>
      </div>
      <Resource query={settings}>{(items) => <SitePersonalSettingsList items={items} />}</Resource>
    </section>
  );
}

export function SitePersonalSettingsList({ items }: { items: SitePersonalSettings[] }) {
  return (
    <ResponsiveTable
      rows={items}
      rowKey={(item) => item.userId}
      label={text.sitePersonalListTitle}
      empty={text.sitePersonalListEmpty}
      columns={[
        {
          key: 'user',
          priority: 'primary',
          header: text.sitePersonalListUser,
          render: (item) => item.userName ?? item.userId,
        },
        {
          key: 'account',
          priority: 'primary',
          header: text.sitePersonalListAccount,
          className: 'mono',
          render: (item) => item.accountName || NOT_SET,
        },
        {
          key: 'workDirectory',
          priority: 'secondary',
          header: text.workDirectory,
          className: 'mono',
          render: (item) => item.workDirectory ?? text.siteUsesComputerSetting,
        },
        {
          key: 'variables',
          priority: 'secondary',
          header: text.sitePersonalListVariables,
          className: 'mono site-variables-cell',
          render: (item) => formatSiteVariables(item.variables) || NOT_SET,
        },
        {
          key: 'key',
          priority: 'secondary',
          header: text.sitePersonalListKey,
          render: (item) =>
            item.key ? (
              <span className="job-cell-lines">
                <span>{siteKeyStatusLabels[item.key.status]}</span>
                {item.key.fingerprint && <span className="mono">{item.key.fingerprint}</span>}
              </span>
            ) : (
              NOT_SET
            ),
        },
        {
          key: 'updated',
          priority: 'secondary',
          header: text.sitePersonalListUpdatedAt,
          render: (item) => formatDate(item.updatedAt),
        },
      ]}
    />
  );
}
