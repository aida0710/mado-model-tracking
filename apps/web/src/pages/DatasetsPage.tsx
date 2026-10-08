import { useState, type ReactNode } from 'react';
import type { Dataset, DatasetVersion } from '@mmt/contracts';
import { Link } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { registryApi } from '../api/registry';
import { trackingApi } from '../api/tracking';
import { useProject } from '../hooks/useProject';
import { useRegistry } from '../hooks/useRegistry';
import { useQuery } from '../hooks/useQuery';
import { useDatasetVersionsById } from '../hooks/useDatasetVersionsById';
import { PageHeader } from '../components/PageHeader';
import { ResponsiveTable } from '../components/ResponsiveTable';
import { RegistryLayout } from '../components/RegistryLayout';
import { Empty, ErrorNotice, Resource } from '../components/Feedback';
import { DetailsList, JsonDetails } from '../components/JsonDetails';
import { FormDialog } from '../components/FormDialog';
import { DatasetVersionDialog, type DatasetVersionSource } from '../dialogs/DatasetVersionDialog';
import { DatasetFiles } from '../components/DatasetFiles';
import { datasetVersionLabel } from '../lib/datasetVersionLabel';
import { formatBytes } from '../lib/format';
import { getFieldValue } from '../lib/formValues';
import { text, textTemplates } from '../i18n/catalog';

export function DatasetsPage() {
  const { project, canEdit, isProjectAdmin } = useProject();
  const [dialog, setDialog] = useState<'dataset' | DatasetVersionSource | null>(null);
  const registry = useRegistry(`${project.id}:datasets`, {
    list: (signal) => registryApi.datasets(project.id, signal),
    versions: (id, signal) => registryApi.datasetVersions(project.id, id, signal),
    parentId: (version) => version.datasetId,
  });
  const base = `/projects/${project.id}`;
  return (
    <section className="page datasets-page touch-targets">
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
              <ResponsiveTable
                rows={items}
                rowKey={(item) => item.id}
                selectedKey={registry.selected?.id}
                columns={[
                  {
                    key: 'name',
                    header: text.name,
                    priority: 'primary',
                    render: (item) => (
                      <button className="link-button" onClick={() => registry.selectItem(item.id)}>
                        {item.name}
                      </button>
                    ),
                  },
                  { key: 'namespace', header: text.namespace, priority: 'secondary', render: (item) => item.namespace },
                  {
                    key: 'version',
                    header: text.latestVersion,
                    priority: 'primary',
                    render: (item) => item.latestVersion ?? '—',
                    className: 'mono break-word',
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
                    <div className="section-heading-actions">
                      <button className="button small" onClick={() => setDialog('folder')}>
                        {text.datasetVersionFromFolder}
                      </button>
                      <button className="button small" onClick={() => setDialog('reference')}>
                        {text.newVersion}
                      </button>
                    </div>
                  )}
                </div>
                <Resource query={registry.versions}>
                  {(versions) => (
                    <>
                      <ResponsiveTable
                        rows={versions}
                        rowKey={(version) => version.id}
                        selectedKey={registry.selectedVersion?.id}
                        columns={[
                          {
                            key: 'version',
                            header: text.version,
                            priority: 'primary',
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
                            key: 'content',
                            header: text.datasetContentKind,
                            priority: 'primary',
                            render: (version) =>
                              version.contentKind === 'artifacts'
                                ? textTemplates.datasetContentArtifacts(
                                    version.fileCount ?? 0,
                                    formatBytes(version.totalSize ?? 0),
                                  )
                                : text.datasetContentReference,
                          },
                          {
                            key: 'uri',
                            header: text.uri,
                            priority: 'secondary',
                            render: (version) => (
                              <span className="mono break-word">{version.uri}</span>
                            ),
                          },
                          {
                            key: 'digest',
                            header: text.digest,
                            priority: 'secondary',
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
                                registry.selectedVersion.parentDatasetVersionIds.length > 0 ? (
                                  <ParentVersionLinks
                                    version={registry.selectedVersion}
                                    loadedVersions={versions}
                                    datasets={items}
                                  />
                                ) : null,
                              ],
                              ...(registry.selectedVersion.contentKind === 'artifacts'
                                ? artifactContentEntries(registry.selectedVersion)
                                : []),
                              [
                                text.sourceRun,
                                registry.selectedVersion.sourceRunId ? (
                                  <SourceRunLink
                                    projectId={project.id}
                                    runId={registry.selectedVersion.sourceRunId}
                                  />
                                ) : null,
                              ],
                            ]}
                          />
                          <h3>{text.datasetFiles}</h3>
                          {registry.selectedVersion.contentKind === 'artifacts' ? (
                            <DatasetFiles
                              key={registry.selectedVersion.id}
                              version={registry.selectedVersion}
                            />
                          ) : (
                            <p className="muted">{text.datasetFilesReferenceOnly}</p>
                          )}
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
      {(dialog === 'reference' || dialog === 'folder') && registry.selected && (
        <DatasetVersionDialog
          dataset={registry.selected}
          source={dialog}
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

// Run ids are UUIDs; the first block stands in until the Run's name is loaded.
const SHORT_RUN_ID_LENGTH = 8;

/** The parents by version name (with the dataset's name when it is another dataset). */
function ParentVersionLinks({
  version,
  loadedVersions,
  datasets,
}: {
  version: DatasetVersion;
  loadedVersions: DatasetVersion[];
  datasets: Dataset[];
}) {
  const { project } = useProject();
  const parents = useDatasetVersionsById({
    projectId: project.id,
    ids: version.parentDatasetVersionIds,
    loadedVersions,
    datasets,
  });
  return (
    <>
      {version.parentDatasetVersionIds.map((id) => {
        const parent = parents.get(id);
        return (
          <Link
            key={id}
            className={parent ? 'version-link' : 'version-link mono'}
            to={`/projects/${project.id}/datasets?version=${id}`}
          >
            {parent ? datasetVersionLabel(parent, version.datasetId) : id}
          </Link>
        );
      })}
    </>
  );
}

function SourceRunLink({ projectId, runId }: { projectId: string; runId: string }) {
  const run = useQuery(`${projectId}:run:${runId}`, (signal) => trackingApi.run(projectId, runId, signal));
  return (
    <Link to={`/projects/${projectId}/runs/${runId}`}>
      {run.value?.name ?? runId.slice(0, SHORT_RUN_ID_LENGTH)}
    </Link>
  );
}

function artifactContentEntries(version: DatasetVersion): Array<[string, ReactNode]> {
  return [
    [text.datasetFileCount, version.fileCount],
    [text.datasetTotalSize, formatBytes(version.totalSize ?? 0)],
  ];
}
