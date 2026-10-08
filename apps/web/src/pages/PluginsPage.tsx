import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { useAuth } from '../hooks/useAuth';
import { useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { Resource } from '../components/Feedback';
import { ResponsiveTable } from '../components/ResponsiveTable';
import { RegistryLayout } from '../components/RegistryLayout';
import { PluginPanel } from '../components/PluginPanel';
import { PluginDialog } from '../dialogs/PluginDialog';
import { getPluginConnectionKey } from '../lib/pluginConnection';
import { canManagePlugins, isGlobalAdmin } from '../lib/permissions';
import { text } from '../i18n/catalog';

/**
 * Plugin connections of the Project. The navigation hides this screen from members the API would
 * refuse; opening the URL directly shows why instead of a 403 that retrying cannot fix.
 */
export function PluginsPage() {
  const { project } = useProject();
  const { user } = useAuth();
  if (!canManagePlugins(project.role, isGlobalAdmin(user)))
    return (
      <section className="page management-page">
        <PageHeader title={text.plugins} eyebrow={project.name} />
        <p className="notice">{text.pluginsAdminOnly}</p>
      </section>
    );
  return <PluginConnections />;
}

function PluginConnections() {
  const { project } = useProject();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [showDialog, setShowDialog] = useState(false);
  const plugins = useQuery(`${project.id}:plugins`, (signal) =>
    administrationApi.plugins(project.id, signal),
  );
  return (
    <section className="page management-page">
      <PageHeader
        title={text.plugins}
        eyebrow={project.name}
        actions={
          <>
            {user.isAdmin && (
              <button className="button primary" onClick={() => setShowDialog(true)}>
                <Plus size={15} />
                {text.newPlugin}
              </button>
            )}
            <button className="icon-button" aria-label={text.refresh} onClick={plugins.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <Resource query={plugins}>
        {(items) => {
          const selected = items.find((plugin) => plugin.id === params.get('id')) ?? items[0];
          return (
            <RegistryLayout
              list={
                <ResponsiveTable
                  rows={items}
                  rowKey={(plugin) => plugin.id}
                  selectedKey={selected?.id}
                  columns={[
                    {
                      key: 'name',
                      priority: 'primary',
                      header: text.name,
                      render: (plugin) => (
                        <button
                          className="link-button"
                          onClick={() => setParams({ id: plugin.id })}
                        >
                          {plugin.name}
                        </button>
                      ),
                    },
                    {
                      key: 'url',
                      priority: 'secondary',
                      header: text.baseUrl,
                      className: 'long-value',
                      render: (plugin) => plugin.baseUrl,
                    },
                    {
                      key: 'enabled',
                      priority: 'primary',
                      header: text.enabled,
                      render: (plugin) => (
                        <input
                          type="checkbox"
                          disabled
                          checked={plugin.enabled}
                          aria-label={text.enabled}
                          readOnly
                        />
                      ),
                    },
                  ]}
                />
              }
            >
              {selected && (
                <PluginPanel key={getPluginConnectionKey(selected)} plugin={selected} onChanged={plugins.reload} />
              )}
            </RegistryLayout>
          );
        }}
      </Resource>
      {user.isAdmin && showDialog && (
        <PluginDialog
          onClose={() => setShowDialog(false)}
          onSaved={(plugin) => {
            setShowDialog(false);
            plugins.reload();
            setParams({ id: plugin.id });
          }}
        />
      )}
    </section>
  );
}
