import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { registryApi } from '../api/registry';
import { useProject } from '../hooks/useProject';
import { useRegistry } from '../hooks/useRegistry';
import { PageHeader } from '../components/PageHeader';
import { StandaloneArtifactUpload } from '../components/StandaloneArtifactUpload';
import { DataTable } from '../components/DataTable';
import { RegistryLayout } from '../components/RegistryLayout';
import { Empty, ErrorNotice, Resource } from '../components/Feedback';
import { DetailsList, JsonDetails } from '../components/JsonDetails';
import { FormDialog } from '../components/FormDialog';
import { ModelVersionDialog } from '../dialogs/ModelVersionDialog';
import { getFieldValue } from '../lib/formValues';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

export function ModelsPage() {
  const { project, canEdit } = useProject();
  const [dialog, setDialog] = useState<'model' | 'version' | 'alias' | null>(null);
  const registry = useRegistry(`${project.id}:models`, {
    list: (signal) => registryApi.models(project.id, signal),
    versions: (id, signal) => registryApi.modelVersions(project.id, id, signal),
    parentId: (version) => version.modelId,
  });
  const base = `/projects/${project.id}`;
  return (
    <section className="page">
      <PageHeader
        title={text.models}
        eyebrow={project.name}
        actions={
          <>
            {canEdit && <StandaloneArtifactUpload projectId={project.id} />}
            {canEdit && (
              <button className="button primary" onClick={() => setDialog('model')}>
                <Plus size={15} />
                {text.newModel}
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
                  {
                    key: 'family',
                    label: text.family,
                    render: (item) => <span className="mono">{item.family}</span>,
                  },
                  {
                    key: 'version',
                    label: text.latestVersion,
                    render: (item) => item.latestVersion ?? '—',
                    className: 'mono',
                  },
                  {
                    key: 'aliases',
                    label: text.alias,
                    render: (item) => Object.keys(item.aliases).join(', ') || '—',
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
                    <div>
                      <button className="button small" onClick={() => setDialog('alias')}>
                        {text.assignAlias}
                      </button>
                      <button className="button small" onClick={() => setDialog('version')}>
                        {text.newVersion}
                      </button>
                    </div>
                  )}
                </div>
                <p className="muted">{registry.selected.description}</p>
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
                            key: 'source',
                            label: text.sourceRun,
                            render: (version) =>
                              version.sourceRunId ? (
                                <Link to={`${base}/runs/${version.sourceRunId}`}>
                                  {version.sourceRunId}
                                </Link>
                              ) : (
                                '—'
                              ),
                          },
                          {
                            key: 'created',
                            label: text.created,
                            render: (version) => formatDate(version.createdAt),
                          },
                        ]}
                      />
                      {registry.selectedVersion && (
                        <div className="version-detail">
                          <DetailsList
                            entries={[
                              [text.version, registry.selectedVersion.version],
                              [
                                text.parents,
                                registry.selectedVersion.parentModelVersionIds.map((id) => (
                                  <Link
                                    key={id}
                                    className="version-link mono"
                                    to={`${base}/models?version=${id}`}
                                  >
                                    {id}
                                  </Link>
                                )),
                              ],
                              [
                                text.weightsUri,
                                <span className="mono break-word">
                                  {registry.selectedVersion.weightsUri}
                                </span>,
                              ],
                              [text.artifactId, registry.selectedVersion.artifactId],
                              [
                                text.defaultCode,
                                registry.selectedVersion.defaultCodeVersionId ? (
                                  <Link
                                    className="mono"
                                    to={`${base}/codes?version=${registry.selectedVersion.defaultCodeVersionId}`}
                                  >
                                    {registry.selectedVersion.defaultCodeVersionId}
                                  </Link>
                                ) : null,
                              ],
                            ]}
                          />
                          <h3>{text.metadata}</h3>
                          <JsonDetails value={registry.selectedVersion.metadata} />
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
      {dialog === 'model' && (
        <FormDialog
          title={text.newModel}
          onClose={() => setDialog(null)}
          fields={[
            { name: 'name', label: text.name, required: true },
            { name: 'family', label: text.family, required: true },
            { name: 'description', label: text.description, type: 'textarea' },
          ]}
          onSubmit={(values) =>
            registryApi.createModel(project.id, {
              name: getFieldValue(values, 'name'),
              family: getFieldValue(values, 'family'),
              description: getFieldValue(values, 'description'),
            })
          }
          onSaved={(model) => {
            setDialog(null);
            registry.reload();
            registry.selectItem(model.id);
          }}
        />
      )}
      {dialog === 'version' && registry.selected && (
        <ModelVersionDialog
          model={registry.selected}
          onClose={() => setDialog(null)}
          onSaved={(version) => {
            setDialog(null);
            registry.reload();
            registry.selectVersion(version.id);
          }}
        />
      )}
      {dialog === 'alias' && registry.selected && (
        <FormDialog
          title={text.assignAlias}
          onClose={() => setDialog(null)}
          fields={[
            { name: 'alias', label: text.alias, required: true },
            {
              name: 'version',
              label: text.version,
              type: 'select',
              required: true,
              defaultValue: registry.selectedVersion?.id,
              options: (registry.versions.value ?? []).map((version) => ({
                value: version.id,
                label: version.version,
              })),
            },
          ]}
          onSubmit={(values) =>
            registryApi.assignAlias(
              project.id,
              registry.selected!.id,
              getFieldValue(values, 'alias'),
              getFieldValue(values, 'version'),
            )
          }
          onSaved={() => {
            setDialog(null);
            registry.reload();
          }}
        />
      )}
    </section>
  );
}
