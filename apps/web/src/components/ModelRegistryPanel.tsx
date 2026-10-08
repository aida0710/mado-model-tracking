import { Link } from 'react-router-dom';
import type { ModelRegistryState } from '../types/modelRegistry';
import { DataTable } from './DataTable';
import { RegistryLayout } from './RegistryLayout';
import { Empty, ErrorNotice, Resource } from './Feedback';
import { DetailsList, JsonDetails } from './JsonDetails';
import { ModelAliasHistory } from './ModelAliasHistory';
import type { ModelAliasHistoryState } from '../hooks/useModelAliasHistory';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

export function ModelRegistryPanel({
  registry,
  projectId,
  canEdit,
  aliasHistory,
  onCreateVersion,
  onAssignAlias,
  onRemoveAlias,
}: {
  registry: ModelRegistryState;
  projectId: string;
  canEdit: boolean;
  aliasHistory: ModelAliasHistoryState;
  onCreateVersion: () => void;
  onAssignAlias: () => void;
  onRemoveAlias: (assignment: { alias: string; version: string }) => void;
}) {
  const base = `/projects/${projectId}`;
  const versionLabel = (versionId: string) =>
    registry.versions.value?.find((version) => version.id === versionId)?.version ?? versionId;
  return (
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
                    <button className="button small" onClick={onAssignAlias}>
                      {text.assignAlias}
                    </button>
                    <button className="button small" onClick={onCreateVersion}>
                      {text.newVersion}
                    </button>
                  </div>
                )}
              </div>
              <p className="muted">{registry.selected.description}</p>
              <DataTable
                items={Object.entries(registry.selected.aliases)}
                rowKey={([alias]) => alias}
                empty={text.aliasesEmpty}
                columns={[
                  {
                    key: 'alias',
                    label: text.alias,
                    className: 'mono',
                    render: ([alias]) => alias,
                  },
                  {
                    key: 'version',
                    label: text.version,
                    className: 'mono',
                    render: ([, versionId]) => versionLabel(versionId),
                  },
                  ...(canEdit
                    ? [
                        {
                          key: 'actions',
                          label: '',
                          render: ([alias, versionId]: [string, string]) => (
                            <button
                              className="button small"
                              onClick={() =>
                                onRemoveAlias({ alias, version: versionLabel(versionId) })
                              }
                            >
                              {text.removeAlias}
                            </button>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
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
              <ModelAliasHistory history={aliasHistory} />
            </>
          ) : (
            <Empty>{text.selectItem}</Empty>
          )}
        </RegistryLayout>
      )}
    </Resource>
  );
}
