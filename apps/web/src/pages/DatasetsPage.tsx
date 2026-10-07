import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { registryApi } from '../api/registry';
import { useProject } from '../hooks/useProject';
import { useRegistry } from '../hooks/useRegistry';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { RegistryLayout } from '../components/RegistryLayout';
import { Empty, ErrorNotice, Resource } from '../components/Feedback';
import { DetailsList, JsonDetails } from '../components/JsonDetails';
import { FormDialog } from '../components/FormDialog';
import { DatasetVersionDialog } from '../dialogs/DatasetVersionDialog';
import { getFieldValue } from '../lib/formValues';
import { text } from '../i18n/catalog';

export function DatasetsPage() {
  const { project, canEdit, isProjectAdmin } = useProject();
  const [dialog, setDialog] = useState<'dataset' | 'version' | null>(null);
  const registry = useRegistry(`${project.id}:datasets`, {
    list: (signal) => registryApi.datasets(project.id, signal),
    versions: (id, signal) => registryApi.datasetVersions(project.id, id, signal),
    parentId: (version) => version.datasetId,
  });
  const base = `/projects/${project.id}`;
  return (
    <section className="page">
      <PageHeader
        title={text.datasets}
        eyebrow={project.name}
        actions={
          <>
            {isProjectAdmin && (
              <Link className="button" to={`${base}/plugins`}>
                {text.importMado}
              </Link>
            )}
            {canEdit && (
              <button className="button primary" onClick={() => setDialog('dataset')}>
                <Plus size={15} />
                {text.newDataset}
              </button>
            )}
            <button className="icon-button" aria-label={text.refresh} onClick={registry.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <Resource query={registry.list}>
        {(items) => (
          <RegistryLayout
            list={
              <DataTable
                items={items}
                rowKey={(item) => item.id}
                selectedKey={registry.selected?.id}
                columns={[
                  {
                    key: 'name',
                    label: text.name,
                    render: (item) => (
                      <button className="link-button" onClick={() => registry.selectItem(item.id)}>
                        {item.name}
                      </button>
                    ),
                  },
                  { key: 'namespace', label: text.namespace, render: (item) => item.namespace },
                  {
                    key: 'version',
                    label: text.latestVersion,
                    render: (item) => item.latestVersion ?? '—',
                    className: 'mono',
                  },
                ]}
              />
            }
          >
            <ErrorNotice
              message={registry.lookup.error ?? registry.selectionError}
              retry={registry.lookup.reload}
            />
            {registry.selected ? (
              <>
                <div className="section-heading">
                  <h2>{registry.selected.name}</h2>
                  {canEdit && (
                    <button className="button small" onClick={() => setDialog('version')}>
                      {text.newVersion}
                    </button>
                  )}
                </div>
                <Resource query={registry.versions}>
                  {(versions) => (
                    <>
                      <DataTable
                        items={versions}
                        rowKey={(version) => version.id}
                        selectedKey={registry.selectedVersion?.id}
                        columns={[
                          {
                            key: 'version',
                            label: text.version,
                            render: (version) => (
                              <button
                                className="link-button mono"
                                onClick={() => registry.selectVersion(version.id)}
                              >
                                {version.version}
                              </button>
                            ),
                          },
                          {
                            key: 'uri',
                            label: text.uri,
                            render: (version) => (
                              <span className="mono break-word">{version.uri}</span>
                            ),
                          },
                          {
                            key: 'digest',
                            label: text.digest,
                            render: (version) => (
                              <span className="mono break-word">{version.digest}</span>
                            ),
                          },
                        ]}
                      />
                      {registry.selectedVersion && (
                        <div className="version-detail">
                          <DetailsList
                            entries={[
                              [
                                text.parents,
                                registry.selectedVersion.parentDatasetVersionIds.map((id) => (
                                  <Link
                                    key={id}
                                    className="version-link mono"
                                    to={`${base}/datasets?version=${id}`}
                                  >
                                    {id}
                                  </Link>
                                )),
                              ],
                              [
                                text.sourceRun,
                                registry.selectedVersion.sourceRunId ? (
                                  <Link to={`${base}/runs/${registry.selectedVersion.sourceRunId}`}>
                                    {registry.selectedVersion.sourceRunId}
                                  </Link>
                                ) : null,
                              ],
                            ]}
                          />
                          <h3>{text.schema}</h3>
                          <JsonDetails value={registry.selectedVersion.schema} />
                          <h3>{text.metadata}</h3>
                          <JsonDetails value={registry.selectedVersion.metadata} />
                          {registry.selectedVersion.externalRef && (
                            <>
                              <h3>{text.externalReference}</h3>
                              <JsonDetails value={registry.selectedVersion.externalRef} />
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </Resource>
              </>
            ) : (
              <Empty>{text.selectItem}</Empty>
            )}
          </RegistryLayout>
        )}
      </Resource>
      {dialog === 'dataset' && (
        <FormDialog
          title={text.newDataset}
          onClose={() => setDialog(null)}
          fields={[
            { name: 'name', label: text.name, required: true },
            { name: 'namespace', label: text.namespace },
            { name: 'description', label: text.description, type: 'textarea' },
          ]}
          onSubmit={(values) =>
            registryApi.createDataset(project.id, {
              name: getFieldValue(values, 'name'),
              namespace: getFieldValue(values, 'namespace'),
              description: getFieldValue(values, 'description'),
            })
          }
          onSaved={(dataset) => {
            setDialog(null);
            registry.reload();
            registry.selectItem(dataset.id);
          }}
        />
      )}
      {dialog === 'version' && registry.selected && (
        <DatasetVersionDialog
          dataset={registry.selected}
          onClose={() => setDialog(null)}
          onSaved={(version) => {
            setDialog(null);
            registry.reload();
            registry.selectVersion(version.id);
          }}
        />
      )}
    </section>
  );
}
