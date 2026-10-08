import { Link } from 'react-router-dom';
import type { ModelRegistryState } from '../types/modelRegistry';
import { ResponsiveTable } from './ResponsiveTable';
import { RegistryLayout } from './RegistryLayout';
import { Empty, ErrorNotice, Resource } from './Feedback';
import { DetailsList, JsonDetails } from './JsonDetails';
import { ModelAliasHistory } from './ModelAliasHistory';
import { ModelVersionArtifactLink } from './ModelVersionArtifactLink';
import { RunNameLink } from './RunNameLink';
import type { ModelAliasHistoryState } from '../hooks/useModelAliasHistory';
import { formatDate } from '../lib/format';
import { modelVersionPath } from '../lib/modelVersionPath';
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
            <ResponsiveTable
              rows={items}
              rowKey={(item) => item.id}
              selectedKey={registry.selected?.id}
              columns={[
                {
                  key: 'name',
                  priority: 'primary',
                  header: text.name,
                  render: (item) => (
                    <button className="link-button" onClick={() => registry.selectItem(item.id)}>
                      {item.name}
                    </button>
                  ),
                },
                {
                  key: 'family',
                  priority: 'secondary',
                  header: text.family,
                  render: (item) => <span className="mono">{item.family}</span>,
                },
                {
                  key: 'version',
                  priority: 'primary',
                  header: text.latestVersion,
                  render: (item) => item.latestVersion ?? '—',
                  className: 'mono',
                },
                {
                  key: 'aliases',
                  priority: 'secondary',
                  header: text.alias,
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
              <ResponsiveTable
                rows={Object.entries(registry.selected.aliases)}
                rowKey={([alias]) => alias}
                empty={text.aliasesEmpty}
                columns={[
                  {
                    key: 'alias',
                    priority: 'primary',
                    header: text.alias,
                    className: 'mono',
                    render: ([alias]) => alias,
                  },
                  {
                    key: 'version',
                    priority: 'primary',
                    header: text.version,
                    className: 'mono',
                    render: ([, versionId]) => versionLabel(versionId),
                  },
                  ...(canEdit
                    ? [
                        {
                          key: 'actions',
                          priority: 'primary' as const,
                          header: '',
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
                    <ResponsiveTable
                      rows={versions}
                      rowKey={(version) => version.id}
                      selectedKey={registry.selectedVersion?.id}
                      columns={[
                        {
                          key: 'version',
                          priority: 'primary',
                          header: text.version,
                          render: (version) => (
                            <Link
                              className="mono"
                              to={modelVersionPath(projectId, {
                                modelId: version.modelId,
                                versionId: version.id,
                              })}
                            >
                              {version.version}
                            </Link>
                          ),
                        },
                        {
                          key: 'source',
                          priority: 'primary',
                          header: text.sourceRun,
                          render: (version) =>
                            version.sourceRunId ? (
                              <RunNameLink projectId={projectId} runId={version.sourceRunId} />
                            ) : (
                              '—'
                            ),
                        },
                        {
                          key: 'created',
                          priority: 'secondary',
                          header: text.created,
                          render: (version) => formatDate(version.createdAt),
                        },
                      ]}
                    />
                    {registry.selectedVersion && (
                      <div className="version-detail">
                        <Link
                          to={modelVersionPath(projectId, {
                            modelId: registry.selectedVersion.modelId,
                            versionId: registry.selectedVersion.id,
                          })}
                        >
                          {text.modelVersionOpenPage}
                        </Link>
                        <DetailsList
                          entries={[
                            [text.version, registry.selectedVersion.version],
                            [
                              text.parents,
                              registry.selectedVersion.parentModelVersionIds.length
                                ? registry.selectedVersion.parentModelVersionIds.map((id) => (
                                    <Link
                                      key={id}
                                      className="version-link mono"
                                      to={`${base}/models?version=${id}`}
                                    >
                                      {versionLabel(id)}
                                    </Link>
                                  ))
                                : null,
                            ],
                            [
                              text.weightsUri,
                              registry.selectedVersion.weightsUri ? (
                                <span className="mono break-word">
                                  {registry.selectedVersion.weightsUri}
                                </span>
                              ) : null,
                            ],
                            [
                              text.modelVersionWeightsArtifact,
                              <ModelVersionArtifactLink
                                projectId={projectId}
                                version={registry.selectedVersion}
                              />,
                            ],
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
