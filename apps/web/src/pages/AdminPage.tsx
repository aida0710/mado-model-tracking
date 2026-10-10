import { useState, type ComponentType } from 'react';
import { Navigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Tabs } from '../components/Tabs';
import { AuditEventsPanel } from '../components/admin/AuditEventsPanel';
import { LaunchersPanel } from '../components/admin/LaunchersPanel';
import { StorageBackendsPanel } from '../components/admin/StorageBackendsPanel';
import { UsersPanel } from '../components/admin/UsersPanel';
import { useAuth } from '../hooks/useAuth';
import { isGlobalAdmin } from '../lib/permissions';
import { text } from '../i18n/catalog';

const ADMIN_TAB_PANEL_ID = 'admin-tab-panel';

// Adding a tab is one entry here. The first entry is the default tab.
const adminTabs: Array<{ key: string; label: string; component: ComponentType }> = [
  { key: 'users', label: text.adminTabUsers, component: UsersPanel },
  { key: 'storage', label: text.adminTabStorage, component: StorageBackendsPanel },
  { key: 'launchers', label: text.adminTabLaunchers, component: LaunchersPanel },
  { key: 'audit', label: text.adminTabAudit, component: AuditEventsPanel },
];

/** Global administration (/admin). The API refuses everyone else; others are sent back home. */
export function AdminPage() {
  const auth = useAuth();
  const [selectedKey, setSelectedKey] = useState(adminTabs[0]!.key);
  if (!isGlobalAdmin(auth.user)) return <Navigate replace to="/" />;
  const selected = adminTabs.find((tab) => tab.key === selectedKey) ?? adminTabs[0]!;
  const Panel = selected.component;
  return (
    <>
      <PageHeader title={text.administration} />
      <Tabs
        tabs={adminTabs}
        selected={selected.key}
        onSelect={setSelectedKey}
        panelId={ADMIN_TAB_PANEL_ID}
      />
      <div id={ADMIN_TAB_PANEL_ID} role="tabpanel">
        <Panel />
      </div>
    </>
  );
}
