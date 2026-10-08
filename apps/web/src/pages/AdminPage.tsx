import { useState, type ComponentType } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Tabs } from '../components/Tabs';
import { StorageBackendsPanel } from '../components/admin/StorageBackendsPanel';
import { useAuth } from '../hooks/useAuth';
import { isGlobalAdmin } from '../lib/permissions';
import { text } from '../i18n/catalog';

const ADMIN_TAB_PANEL_ID = 'admin-tab-panel';

// Adding a tab is one entry here.
const adminTabs: Array<{ key: string; label: string; component: ComponentType }> = [
  { key: 'storage', label: text.adminTabStorage, component: StorageBackendsPanel },
];

/** Global administration (/admin). The API refuses everyone else; this only explains why. */
export function AdminPage() {
  const auth = useAuth();
  const [selectedKey, setSelectedKey] = useState(adminTabs[0]!.key);
  if (!isGlobalAdmin(auth.user))
    return (
      <>
        <PageHeader title={text.administration} />
        <p className="notice" role="status">
          {text.adminForbidden}
        </p>
      </>
    );
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
