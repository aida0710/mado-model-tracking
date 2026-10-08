import { Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useProject } from '../hooks/useProject';
import { useModelAutomation } from '../hooks/useModelAutomation';
import { useExecutionCatalog } from '../hooks/useExecutionCatalog';
import { useQuery } from '../hooks/useQuery';
import { executionApi } from '../api/execution';
import { canManageAutomationRules } from '../lib/automationPermissions';
import { AutomationRuleDialog } from '../dialogs/AutomationRuleDialog';
import { AutomationRulesTable } from './AutomationRulesTable';
import { AutomationExecutionsTable } from './AutomationExecutionsTable';
import { AutomationRuleDetails } from './AutomationRuleDetails';
import { QueryDialog } from './QueryDialog';
import { Resource, ErrorNotice } from './Feedback';
import { text } from '../i18n/catalog';

export function ModelAutomationPanel({
  view,
  initialFamily,
}: {
  view: 'rules' | 'history';
  initialFamily?: string;
}) {
  const { project } = useProject();
  const { user } = useAuth();
  const canManage = canManageAutomationRules(project.role, user.isAdmin);
  const automation = useModelAutomation(project.id, view === 'history');
  const registry = useExecutionCatalog(project.id);
  const targets = useQuery('automation-targets', executionApi.targets);
  const catalog =
    registry.value && targets.value
      ? { registry: registry.value, targets: targets.value }
      : undefined;
  const selectedRule = automation.rules.value?.find(
    (rule) => rule.id === automation.selectedRuleId,
  );
  return (
    <section className="automation-panel">
      <div className="section-heading">
        <h2>{view === 'rules' ? text.automationRules : text.automationHistory}</h2>
        <div>
          {canManage && view === 'rules' && (
            <button className="button primary small" onClick={automation.startCreating}>
              <Plus size={15} />
              {text.newAutomationRule}
            </button>
          )}
          <button
            className="icon-button"
            aria-label={text.refresh}
            onClick={() => {
              automation.reload();
              registry.reload();
              targets.reload();
            }}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </div>
      <ErrorNotice message={automation.error} />
      {view === 'history' && (
        <ErrorNotice message={automation.rules.error} retry={automation.rules.reload} />
      )}
      <ErrorNotice message={registry.error} retry={registry.reload} />
      <ErrorNotice message={targets.error} retry={targets.reload} />
      {view === 'rules' ? (
        <>
          <Resource query={automation.rules}>
            {(rules) => (
              <AutomationRulesTable
                rules={rules}
                projectId={project.id}
                catalog={catalog}
                selectedRuleId={automation.selectedRuleId}
                canManage={canManage}
                pending={automation.pending}
                onSelect={automation.selectRule}
                onSetEnabled={(id, enabled) => {
                  void automation.setEnabled(id, enabled);
                }}
              />
            )}
          </Resource>
          {selectedRule && (
            <AutomationRuleDetails rule={selectedRule} catalog={catalog} projectId={project.id} />
          )}
        </>
      ) : (
        <Resource query={automation.executions}>
          {(executions) => (
            <AutomationExecutionsTable
              executions={executions}
              rules={automation.rules.value ?? []}
              projectId={project.id}
              catalog={registry.value}
            />
          )}
        </Resource>
      )}
      {canManage && automation.isCreating && (
        <QueryDialog
          title={text.newAutomationRule}
          onClose={automation.stopCreating}
          query={registry}
        >
          {(choices) => (
            <QueryDialog
              title={text.newAutomationRule}
              onClose={automation.stopCreating}
              query={targets}
            >
              {(computeTargets) => (
                <AutomationRuleDialog
                  catalog={{ registry: choices, targets: computeTargets }}
                  initialFamilies={initialFamily ? [initialFamily] : []}
                  onClose={automation.stopCreating}
                  onSaved={(rule) => {
                    automation.stopCreating();
                    automation.selectRule(rule.id);
                    automation.reload();
                  }}
                />
              )}
            </QueryDialog>
          )}
        </QueryDialog>
      )}
    </section>
  );
}
