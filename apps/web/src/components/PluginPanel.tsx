import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PluginConnection, PluginDataset, PluginManifest } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { useAuth } from '../hooks/useAuth';
import { useMutation } from '../hooks/useMutation';
import { getPluginConnectionKey } from '../lib/pluginConnection';
import { ResponsiveTable } from './ResponsiveTable';
import { DetailsList, JsonDetails } from './JsonDetails';
import { PluginDialog } from '../dialogs/PluginDialog';
import { Empty, ErrorNotice } from './Feedback';
import { PluginStorageMetrics } from './PluginStorageMetrics';
import { PluginOutboxStatus } from './PluginOutboxStatus';
import { usePluginOutboxSummary } from '../hooks/usePluginOutboxSummary';
import { text } from '../i18n/catalog';

export function PluginPanel({
  plugin,
  onChanged,
}: {
  plugin: PluginConnection;
  onChanged: () => void;
}) {
  const { project, isProjectAdmin } = useProject();
  const { user } = useAuth();
  const [showEdit, setShowEdit] = useState(false);
  const [query, setQuery] = useState('');
  const [datasets, setDatasets] = useState<PluginDataset[] | null>(null);
  const [manifest, setManifest] = useState<PluginManifest | null>(plugin.manifest);
  useEffect(() => setManifest(plugin.manifest), [plugin.manifest]);
  const [success, setSuccess] = useState('');
  const mutation = useMutation();
  const canManage = isProjectAdmin || user.isAdmin;
  const outbox = usePluginOutboxSummary(project.id, canManage ? plugin.id : null);
  async function runPluginOperation(operation: () => Promise<void>) {
    setSuccess('');
    return mutation.run(operation);
  }
  return (
    <>
      <div className="section-heading">
        <h2>{plugin.name}</h2>
        {(isProjectAdmin || user.isAdmin) && (
          <div>
            <button
              className="button small"
              disabled={mutation.pending || !plugin.enabled}
              onClick={() =>
                void runPluginOperation(async () => {
                  const checked = await administrationApi.checkPlugin(project.id, plugin.id);
                  setManifest(checked);
                  setSuccess(text.checked);
                  onChanged();
                })
              }
            >
              {text.checkPlugin}
            </button>
            <button
              className="button small"
              disabled={mutation.pending || !plugin.enabled}
              onClick={() =>
                void runPluginOperation(async () => {
                  const retried = await administrationApi.retryEvents(project.id, plugin.id);
                  setSuccess(`${text.queuedEvents}: ${retried.queued}`);
                  outbox.reload();
                })
              }
            >
              {text.retryEvents}
            </button>
          </div>
        )}
      </div>
      <DetailsList
        entries={[
          [text.baseUrl, plugin.baseUrl],
          [text.tokenEnv, <code>{plugin.tokenEnv}</code>],
          [text.pluginVersion, manifest?.version],
          [text.capabilities, manifest?.capabilities.join(', ')],
        ]}
      />
      {user.isAdmin && <div className="section-actions">
        <button className="button small" onClick={() => setShowEdit(true)} disabled={mutation.pending}>{text.editPlugin}</button>
        <button className="button small" disabled={mutation.pending} data-testid="plugin-toggle"
          onClick={() => void runPluginOperation(async () => {
            await administrationApi.updatePlugin(project.id, plugin.id, { enabled: !plugin.enabled }); onChanged();
          })}>{plugin.enabled ? text.disablePlugin : text.enablePlugin}</button>
      </div>}
      {canManage && <PluginOutboxStatus summary={outbox} />}
      <details className="plugin-manifest"><summary>{text.manifest}</summary>
        {manifest ? <JsonDetails value={manifest} /> : <p className="muted">{text.manifestUnchecked}</p>}
      </details>
      <ErrorNotice message={mutation.error} />
      {success && (
        <p className="notice success" role="status">
          {success}
        </p>
      )}
      {(isProjectAdmin || user.isAdmin) && plugin.enabled && manifest?.capabilities.includes('storage:metrics') && (
        <PluginStorageMetrics pluginId={plugin.id} />
      )}
      {(isProjectAdmin || user.isAdmin) && plugin.enabled && (
        <>
          <form
            className="plugin-search"
            onSubmit={(event) => {
              event.preventDefault();
              setSuccess('');
              setDatasets(null);
              void runPluginOperation(async () => {
                const found = await administrationApi.searchDatasets(project.id, plugin.id, query);
                setDatasets(found);
              });
            }}
          >
            <label className="field">
              <span>{text.searchDatasets}</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={text.searchDatasets}
              />
            </label>
            <button className="button primary" disabled={mutation.pending}>
              {mutation.pending ? text.loading : text.search}
            </button>
          </form>
          {datasets &&
            (datasets.length ? (
              <ResponsiveTable
                rows={datasets}
                rowKey={(dataset) => `${dataset.externalId}:${dataset.version}`}
                columns={[
                  {
                    key: 'name',
                    priority: 'primary',
                    header: text.name,
                    render: (dataset) => `${dataset.namespace}/${dataset.name}`,
                  },
                  {
                    key: 'version',
                    priority: 'primary',
                    header: text.version,
                    className: 'mono',
                    render: (dataset) => dataset.version,
                  },
                  {
                    key: 'uri',
                    priority: 'secondary',
                    header: text.uri,
                    className: 'mono long-value',
                    render: (dataset) => dataset.uri,
                  },
                  {
                    key: 'digest',
                    priority: 'secondary',
                    header: text.digest,
                    className: 'mono long-value',
                    render: (dataset) => dataset.digest,
                  },
                  {
                    key: 'import',
                    priority: 'secondary',
                    header: text.importing,
                    render: (dataset) => (
                      <button
                        className="button small"
                        disabled={mutation.pending}
                        onClick={() =>
                          void runPluginOperation(async () => {
                            const imported = await administrationApi.importDataset(
                              project.id,
                              plugin.id,
                              dataset,
                            );
                            setSuccess(`${text.success}: ${imported.name} / ${imported.version}`);
                            onChanged();
                          })
                        }
                      >
                        {text.importDataset}
                      </button>
                    ),
                  },
                ]}
              />
            ) : (
              <Empty>{text.noResults}</Empty>
            ))}
        </>
      )}
      <Link className="button small" to={`/projects/${project.id}/datasets`}>
        {text.datasets}
      </Link>
      {user.isAdmin && showEdit && (
        <PluginDialog
          plugin={plugin}
          onClose={() => setShowEdit(false)}
          onSaved={(savedPlugin) => {
            // The saved connection is active before the parent GET finishes.
            if (getPluginConnectionKey(savedPlugin) !== getPluginConnectionKey(plugin)) {
              setManifest(savedPlugin.manifest);
              setDatasets(null);
              setQuery('');
              setSuccess('');
              mutation.clearError();
            }
            setShowEdit(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}
