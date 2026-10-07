import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { useAuth } from '../hooks/useAuth';
import { useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { Resource } from '../components/Feedback';
import { DataTable } from '../components/DataTable';
import { RegistryLayout } from '../components/RegistryLayout';
import { PluginPanel } from '../components/PluginPanel';
import { FormDialog } from '../components/FormDialog';
import { getFieldValue } from '../lib/formValues';
import { text } from '../i18n/catalog';

export function PluginsPage() {
  const { project } = useProject();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [showDialog, setShowDialog] = useState(false);
  const plugins = useQuery(`${project.id}:plugins`, (signal) =>
    administrationApi.plugins(project.id, signal),
  );
  return (
    <section className="page">
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
                <DataTable
                  items={items}
                  rowKey={(plugin) => plugin.id}
                  selectedKey={selected?.id}
                  columns={[
                    {
                      key: 'name',
                      label: text.name,
                      render: (plugin) => (
                        <button
                          className="link-button"
                          onClick={() => setParams({ id: plugin.id })}
                        >
                          {plugin.name}
                        </button>
                      ),
                    },
                    { key: 'url', label: text.baseUrl, render: (plugin) => plugin.baseUrl },
                    {
                      key: 'enabled',
                      label: text.enabled,
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
                <PluginPanel key={selected.id} plugin={selected} onChanged={plugins.reload} />
              )}
            </RegistryLayout>
          );
        }}
      </Resource>
      {user.isAdmin && showDialog && (
        <FormDialog
          title={text.newPlugin}
          onClose={() => setShowDialog(false)}
          fields={[
            { name: 'name', label: text.name, required: true },
            { name: 'baseUrl', label: text.baseUrl, type: 'url', required: true },
            { name: 'tokenEnv', label: text.tokenEnv, required: true },
            { name: 'enabled', label: text.enabled, type: 'checkbox', defaultValue: 'true' },
          ]}
          onSubmit={(values) =>
            administrationApi.createPlugin(project.id, {
              name: getFieldValue(values, 'name'),
              baseUrl: getFieldValue(values, 'baseUrl'),
              tokenEnv: getFieldValue(values, 'tokenEnv'),
              enabled: getFieldValue(values, 'enabled') === 'true',
            })
          }
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
