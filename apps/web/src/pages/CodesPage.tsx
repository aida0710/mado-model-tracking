import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { registryApi } from '../api/registry';
import { useProject } from '../hooks/useProject';
import { useRegistry } from '../hooks/useRegistry';
import { PageHeader } from '../components/PageHeader';
import { StandaloneArtifactUpload } from '../components/StandaloneArtifactUpload';
import { ResponsiveTable } from '../components/ResponsiveTable';
import { RegistryLayout } from '../components/RegistryLayout';
import { Empty, ErrorNotice, Resource } from '../components/Feedback';
import { JsonDetails } from '../components/JsonDetails';
import { CodeRuntimeDetails } from '../components/CodeRuntimeDetails';
import { FormDialog } from '../components/FormDialog';
import { CodeVersionDialog } from '../dialogs/CodeVersionDialog';
import { getFieldValue } from '../lib/formValues';
import { text } from '../i18n/catalog';
import { runtimeLabels } from '../i18n/runtime';

export function CodesPage() {
  const { project, canEdit } = useProject();
  const [dialog, setDialog] = useState<'code' | 'version' | null>(null);
  const registry = useRegistry(`${project.id}:codes`, {
    list: (signal) => registryApi.codes(project.id, signal),
    versions: (id, signal) => registryApi.codeVersions(project.id, id, signal),
    parentId: (version) => version.codeId,
  });
  return (
    <section className="page codes-page">
      <PageHeader
        title={text.codes}
        eyebrow={project.name}
        actions={
          <>
            {canEdit && <StandaloneArtifactUpload projectId={project.id} />}
            {canEdit && (
              <button className="button primary" onClick={() => setDialog('code')}>
                <Plus size={15} />
                {text.newCode}
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
                    priority: 'primary',
                    header: text.name,
                    render: (item) => (
                      <button className="link-button" onClick={() => registry.selectItem(item.id)}>
                        {item.name}
                      </button>
                    ),
                  },
                  {
                    key: 'version',
                    priority: 'primary',
                    header: text.latestVersion,
                    render: (item) => item.latestVersion ?? '—',
                    className: 'mono',
                  },
                  {
                    key: 'description',
                    priority: 'secondary',
                    header: text.description,
                    render: (item) => item.description,
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
                              <button
                                className="link-button mono"
                                onClick={() => registry.selectVersion(version.id)}
                              >
                                {version.version}
                              </button>
                            ),
                          },
                          {
                            key: 'runtime',
                            priority: 'primary',
                            header: text.runtime,
                            render: (version) => runtimeLabels[version.runtime.kind],
                          },
                          {
                            key: 'source',
                            priority: 'secondary',
                            header: text.source,
                            render: (version) =>
                              version.source
                                ? text[`${version.source.kind}Source`]
                                : text.imageSource,
                          },
                          {
                            key: 'families',
                            priority: 'secondary',
                            header: text.family,
                            render: (version) => version.supportedModelFamilies.join(', '),
                          },
                          {
                            key: 'tasks',
                            priority: 'secondary',
                            header: text.taskTypes,
                            render: (version) =>
                              version.taskTypes.map((kind) => text[kind]).join(', '),
                          },
                        ]}
                      />
                      {registry.selectedVersion && (
                        <div className="version-detail">
                          <CodeRuntimeDetails version={registry.selectedVersion} />
                          {registry.selectedVersion.source && (
                            <>
                              <h3>{text.source}</h3>
                              <JsonDetails value={registry.selectedVersion.source} />
                            </>
                          )}
                          <h3>{text.environment}</h3>
                          <JsonDetails value={registry.selectedVersion.environment} />
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
      {dialog === 'code' && (
        <FormDialog
          title={text.newCode}
          onClose={() => setDialog(null)}
          fields={[
            { name: 'name', label: text.name, required: true },
            { name: 'description', label: text.description, type: 'textarea' },
          ]}
          onSubmit={(values) =>
            registryApi.createCode(project.id, {
              name: getFieldValue(values, 'name'),
              description: getFieldValue(values, 'description'),
            })
          }
          onSaved={(code) => {
            setDialog(null);
            registry.reload();
            registry.selectItem(code.id);
          }}
        />
      )}
      {dialog === 'version' && registry.selected && (
        <CodeVersionDialog
          code={registry.selected}
          initialVersion={registry.selectedVersion}
          versions={registry.versions.value}
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
