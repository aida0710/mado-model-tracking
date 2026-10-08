import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { registryApi } from '../api/registry';
import { useProject } from '../hooks/useProject';
import { useRegistry } from '../hooks/useRegistry';
import { PageHeader } from '../components/PageHeader';
import { StandaloneArtifactUpload } from '../components/StandaloneArtifactUpload';
import { FormDialog } from '../components/FormDialog';
import { ModelVersionDialog } from '../dialogs/ModelVersionDialog';
import { ModelAutomationPanel } from '../components/ModelAutomationPanel';
import { ModelRegistryPanel } from '../components/ModelRegistryPanel';
import { Tabs } from '../components/Tabs';
import { getFieldValue } from '../lib/formValues';
import { text } from '../i18n/catalog';

export function ModelsPage() {
  const { project, canEdit } = useProject();
  const [dialog, setDialog] = useState<'model' | 'version' | 'alias' | null>(null);
  const [view, setView] = useState<'registry' | 'rules' | 'history'>('registry');
  const registry = useRegistry(`${project.id}:models`, {
    list: (signal) => registryApi.models(project.id, signal),
    versions: (id, signal) => registryApi.modelVersions(project.id, id, signal),
    parentId: (version) => version.modelId,
  });
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
      <Tabs
        tabs={[
          { key: 'registry', label: text.modelRegistry },
          { key: 'rules', label: text.automationRules },
          { key: 'history', label: text.automationHistory },
        ]}
        selected={view}
        onSelect={(key) => setView(key as typeof view)}
        panelId="model-tab-panel"
      />
      <div id="model-tab-panel" role="tabpanel">
        {view !== 'registry' ? (
          <ModelAutomationPanel view={view} initialFamily={registry.selected?.family} />
        ) : (
          <ModelRegistryPanel
            registry={registry}
            projectId={project.id}
            canEdit={canEdit}
            onCreateVersion={() => setDialog('version')}
            onAssignAlias={() => setDialog('alias')}
          />
        )}
      </div>
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
