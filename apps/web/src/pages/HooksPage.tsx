import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import type { Hook } from '@mmt/contracts';
import { executionApi } from '../api/execution';
import { hooksApi } from '../api/hooks';
import { useAuth } from '../hooks/useAuth';
import { useProject } from '../hooks/useProject';
import { useExecutionCatalog } from '../hooks/useExecutionCatalog';
import { useHookExecutions, useHookList } from '../hooks/useHooks';
import { useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { Tabs } from '../components/Tabs';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { QueryDialog } from '../components/QueryDialog';
import { ErrorNotice, Loading, Resource } from '../components/Feedback';
import { HooksTable } from '../components/HooksTable';
import { HookDetails } from '../components/HookDetails';
import { HookExecutionsTable } from '../components/HookExecutionsTable';
import { HookDialog } from '../dialogs/HookDialog';
import { canManageHooks, canTransferHookOwners, isGlobalAdmin } from '../lib/permissions';
import { text } from '../i18n/catalog';
import { hooksTextTemplates } from '../i18n/hooks';

type HooksView = 'hooks' | 'executions';

/**
 * The Project's hooks: the list with the chosen hook's settings and manual start, and the
 * executions of every hook or of one. `hook` in the URL is the chosen hook in both views.
 */
export function HooksPage() {
  const { project } = useProject();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const view: HooksView = params.get('view') === 'executions' ? 'executions' : 'hooks';
  const selectedHookId = params.get('hook') ?? '';
  const hooks = useHookList(project.id);
  const registry = useExecutionCatalog(project.id);
  const targets = useQuery('hook-targets', executionApi.targets);
  const executions = useHookExecutions(project.id, {
    hookId: selectedHookId,
    enabled: view === 'executions',
  });
  const [isCreating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<Hook | null>(null);
  const canManage = canManageHooks(project.role);
  const canTransferOwner = canTransferHookOwners(project.role, isGlobalAdmin(user));
  const hookItems = hooks.value ?? [];
  const selectedHook = hookItems.find((hook) => hook.id === selectedHookId);
  const catalog =
    registry.value && targets.value
      ? { registry: registry.value, targets: targets.value }
      : undefined;
  const showView = (next: HooksView, hookId = selectedHookId) =>
    setParams(() => {
      const search = new URLSearchParams();
      if (next === 'executions') search.set('view', next);
      if (hookId) search.set('hook', hookId);
      return search;
    });
  const reloadAll = () => {
    hooks.reload();
    registry.reload();
    targets.reload();
    executions.reload();
  };
  return (
    <section className="page hooks-page">
      <PageHeader
        title={text.hooks}
        eyebrow={project.name}
        actions={
          <>
            {canManage && (
              <button className="button primary" onClick={() => setCreating(true)}>
                <Plus size={15} />
                {text.newHook}
              </button>
            )}
            <button className="icon-button" aria-label={text.refresh} onClick={reloadAll}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <Tabs
        tabs={[
          { key: 'hooks', label: text.hookList },
          { key: 'executions', label: text.hookExecutions },
        ]}
        selected={view}
        onSelect={(key) => showView(key as HooksView)}
        panelId="hook-tab-panel"
      />
      <div id="hook-tab-panel" role="tabpanel" className="automation-panel">
        {view === 'hooks' ? (
          <>
            <ErrorNotice message={targets.error} retry={targets.reload} />
            <Resource query={hooks}>
              {(items) => (
                <HooksTable
                  hooks={items}
                  targets={targets.value ?? []}
                  selectedHookId={selectedHookId}
                  pending={Boolean(toggling)}
                  canManage={canManage}
                  onSelect={(hookId) => showView('hooks', hookId)}
                  onToggle={setToggling}
                />
              )}
            </Resource>
            <ErrorNotice message={registry.error} retry={registry.reload} />
            {selectedHook && (
              <HookDetails
                hook={selectedHook}
                catalog={catalog}
                projectId={project.id}
                canStart={canManage}
                canTransferOwner={canTransferOwner}
                onShowExecutions={() => showView('executions', selectedHook.id)}
                onStarted={executions.reload}
                onOwnerTransferred={hooks.reload}
              />
            )}
          </>
        ) : (
          <>
            <label className="chart-selector">
              <span>{text.hookViewFilter}</span>
              <select
                aria-label={text.hookViewFilter}
                value={selectedHookId}
                onChange={(event) => showView('executions', event.target.value)}
              >
                <option value="">{text.hookAllHooks}</option>
                {hookItems.map((hook) => (
                  <option key={hook.id} value={hook.id}>
                    {hook.name}
                  </option>
                ))}
              </select>
            </label>
            <ErrorNotice message={executions.error} retry={executions.reload} />
            {executions.loading && !executions.items.length ? (
              <Loading />
            ) : (
              <HookExecutionsTable
                executions={executions.items}
                hooks={hookItems}
                projectId={project.id}
                showHook={!selectedHookId}
              />
            )}
            {executions.hasMore && (
              <button
                className="button small"
                disabled={executions.loading}
                onClick={executions.loadMore}
              >
                {text.loadMore}
              </button>
            )}
          </>
        )}
      </div>
      {toggling && (
        <ConfirmDialog
          title={toggling.enabled ? text.automationDisable : text.automationEnable}
          message={
            toggling.enabled
              ? hooksTextTemplates.hookDisableConfirm(toggling.name)
              : hooksTextTemplates.hookEnableConfirm(toggling.name)
          }
          confirmLabel={toggling.enabled ? text.automationDisable : text.automationEnable}
          destructive={toggling.enabled}
          onConfirm={() => hooksApi.setEnabled(project.id, toggling.id, !toggling.enabled)}
          onConfirmed={() => {
            setToggling(null);
            hooks.reload();
          }}
          onClose={() => setToggling(null)}
        />
      )}
      {isCreating && (
        <QueryDialog title={text.newHook} onClose={() => setCreating(false)} query={registry}>
          {(choices) => (
            <QueryDialog title={text.newHook} onClose={() => setCreating(false)} query={targets}>
              {(computeTargets) => (
                <HookDialog
                  catalog={{ registry: choices, targets: computeTargets }}
                  onCreated={(hook) => {
                    hooks.reload();
                    showView('hooks', hook.id);
                  }}
                  onClose={() => setCreating(false)}
                />
              )}
            </QueryDialog>
          )}
        </QueryDialog>
      )}
    </section>
  );
}
