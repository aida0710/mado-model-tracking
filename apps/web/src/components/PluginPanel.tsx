import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PluginConnection, PluginDataset, PluginManifest } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { useMutation } from '../hooks/useMutation';
import { DataTable } from './DataTable';
import { DetailsList } from './JsonDetails';
import { Empty, ErrorNotice } from './Feedback';
import { PluginStorageMetrics } from './PluginStorageMetrics';
import { text } from '../i18n/catalog';

export function PluginPanel({
  plugin,
  onChanged,
}: {
  plugin: PluginConnection;
  onChanged: () => void;
}) {
  const { project, isProjectAdmin } = useProject();
  const [query, setQuery] = useState('');
  const [datasets, setDatasets] = useState<PluginDataset[] | null>(null);
  const [manifest, setManifest] = useState<PluginManifest | null>(plugin.manifest);
  useEffect(() => setManifest(plugin.manifest), [plugin.manifest]);
  const [success, setSuccess] = useState('');
  const mutation = useMutation();
  async function runPluginOperation(operation: () => Promise<void>) {
    setSuccess('');
    return mutation.run(operation);
  }
  return (
    <>
      <div className="section-heading">
        <h2>{plugin.name}</h2>
        {isProjectAdmin && (
          <div>
            <button
              className="button small"
              disabled={mutation.pending}
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
              disabled={mutation.pending}
              onClick={() =>
                void runPluginOperation(async () => {
                  const retried = await administrationApi.retryEvents(project.id, plugin.id);
                  setSuccess(`${text.queuedEvents}: ${retried.queued}`);
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
      <ErrorNotice message={mutation.error} />
      {success && (
        <p className="notice success" role="status">
          {success}
        </p>
      )}
      {isProjectAdmin && manifest?.capabilities.includes('storage:metrics') && (
        <PluginStorageMetrics pluginId={plugin.id} />
      )}
      {isProjectAdmin && (
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
              <DataTable
                items={datasets}
                rowKey={(dataset) => `${dataset.externalId}:${dataset.version}`}
                columns={[
                  {
                    key: 'name',
                    label: text.name,
                    render: (dataset) => `${dataset.namespace}/${dataset.name}`,
                  },
                  {
                    key: 'version',
                    label: text.version,
                    className: 'mono',
                    render: (dataset) => dataset.version,
                  },
                  {
                    key: 'uri',
                    label: text.uri,
                    className: 'mono',
                    render: (dataset) => dataset.uri,
                  },
                  {
                    key: 'digest',
                    label: text.digest,
                    className: 'mono',
                    render: (dataset) => dataset.digest,
                  },
                  {
                    key: 'import',
                    label: text.importing,
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
    </>
  );
}
