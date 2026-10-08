import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { registryApi } from '../api/registry';
import { useProject } from '../hooks/useProject';
import { useRegistry } from '../hooks/useRegistry';
import { useModelAliasHistory } from '../hooks/useModelAliasHistory';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageHeader } from '../components/PageHeader';
import { StandaloneArtifactUpload } from '../components/StandaloneArtifactUpload';
import { FormDialog } from '../components/FormDialog';
import { ModelVersionDialog } from '../dialogs/ModelVersionDialog';
import { ModelAutomationPanel } from '../components/ModelAutomationPanel';
import { ModelRegistryPanel } from '../components/ModelRegistryPanel';
import { PromotionPolicyPanel } from '../components/PromotionPolicyPanel';
import { AliasProtectionSettings } from '../components/AliasProtectionSettings';
import { PromotionDialog } from '../dialogs/PromotionDialog';
import { Tabs } from '../components/Tabs';
import { getFieldValue } from '../lib/formValues';
import { text } from '../i18n/catalog';
import { modelsTextTemplates } from '../i18n/models';

export function ModelsPage() {
  const { project, canEdit } = useProject();
  const [dialog, setDialog] = useState<'model' | 'version' | 'alias' | null>(null);
  const [view, setView] = useState<
    'registry' | 'rules' | 'history' | 'promotion' | 'protections'
  >('registry');
  const [aliasToRemove, setAliasToRemove] = useState<{ alias: string; version: string } | null>(
    null,
  );
  const registry = useRegistry(`${project.id}:models`, {
    list: (signal) => registryApi.models(project.id, signal),
    versions: (id, signal) => registryApi.modelVersions(project.id, id, signal),
    parentId: (version) => version.modelId,
  });
  const aliasHistory = useModelAliasHistory(project.id, registry.selected?.id ?? null);
  const reloadRegistryAndAliasHistory = () => {
    registry.reload();
    aliasHistory.reload();
  };
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
            <button
              className="icon-button"
              aria-label={text.refresh}
              onClick={reloadRegistryAndAliasHistory}
            >
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
          { key: 'promotion', label: text.promotionPolicies },
          { key: 'protections', label: text.aliasProtections },
        ]}
        selected={view}
        onSelect={(key) => setView(key as typeof view)}
        panelId="model-tab-panel"
      />
      <div id="model-tab-panel" role="tabpanel">
        {view === 'promotion' ? (
          <PromotionPolicyPanel initialModelId={registry.selected?.id ?? ''} />
        ) : view === 'protections' ? (
          <AliasProtectionSettings models={registry.list.value ?? []} />
        ) : view !== 'registry' ? (
          <ModelAutomationPanel view={view} initialFamily={registry.selected?.family} />
        ) : (
          <ModelRegistryPanel
            registry={registry}
            projectId={project.id}
            canEdit={canEdit}
            aliasHistory={aliasHistory}
            onCreateVersion={() => setDialog('version')}
            onAssignAlias={() => setDialog('alias')}
            onRemoveAlias={setAliasToRemove}
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
        <PromotionDialog
          model={registry.selected}
          versions={registry.versions.value ?? []}
          initial={{ versionId: registry.selectedVersion?.id }}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reloadRegistryAndAliasHistory();
          }}
        />
      )}
      {aliasToRemove && registry.selected && (
        <ConfirmDialog
          title={text.removeAlias}
          message={modelsTextTemplates.removeAliasConfirm(
            aliasToRemove.alias,
            aliasToRemove.version,
          )}
          confirmLabel={text.removeAlias}
          destructive
          onConfirm={() =>
            registryApi.removeAlias(project.id, registry.selected!.id, aliasToRemove.alias)
          }
          onConfirmed={() => {
            setAliasToRemove(null);
            reloadRegistryAndAliasHistory();
          }}
          onClose={() => setAliasToRemove(null)}
        />
      )}
    </section>
  );
}
