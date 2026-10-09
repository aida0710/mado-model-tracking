import type { ComputeTarget, Hook } from '@mmt/contracts';
import { ResponsiveTable } from './ResponsiveTable';
import { automationOwnerLabel } from '../lib/automationOwner';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';
import { hookTriggerLabels } from '../i18n/hooks';
import { submissionModeBadgeLabels } from '../i18n/compute';

function HookTarget({ hook, targets }: { hook: Hook; targets: ComputeTarget[] }) {
  const target = targets.find((item) => item.id === hook.template.targetId);
  if (!target) return <>{hook.template.targetId}</>;
  return (
    <span className="badge-group">
      {target.name}
      {target.executor === 'site' && target.submissionMode === 'manual' && (
        <span className="status-badge status-attention">{submissionModeBadgeLabels.manual}</span>
      )}
    </span>
  );
}

/** The Project's hooks; editors also get the switch that turns a hook on or off. */
export function HooksTable({
  hooks,
  targets,
  selectedHookId,
  pending,
  canManage,
  onSelect,
  onToggle,
}: {
  hooks: Hook[];
  targets: ComputeTarget[];
  selectedHookId: string;
  pending: boolean;
  canManage: boolean;
  onSelect: (hookId: string) => void;
  onToggle: (hook: Hook) => void;
}) {
  return (
    <ResponsiveTable
      rows={hooks}
      rowKey={(hook) => hook.id}
      selectedKey={selectedHookId}
      empty={text.noHooks}
      columns={[
        {
          key: 'name',
          priority: 'primary',
          header: text.name,
          render: (hook) => (
            <button className="link-button" onClick={() => onSelect(hook.id)}>
              {hook.name}
            </button>
          ),
        },
        {
          key: 'trigger',
          priority: 'secondary',
          header: text.hookTrigger,
          render: (hook) => hookTriggerLabels[hook.trigger],
        },
        {
          key: 'target',
          priority: 'secondary',
          header: text.target,
          render: (hook) => <HookTarget hook={hook} targets={targets} />,
        },
        {
          key: 'enabled',
          priority: 'primary',
          header: text.status,
          render: (hook) => (
            <span className={hook.enabled ? 'automation-enabled' : 'muted'}>
              {hook.enabled ? text.hookEnabled : text.hookDisabled}
            </span>
          ),
        },
        {
          key: 'owner',
          priority: 'secondary',
          header: text.hookOwner,
          render: (hook) => <span title={text.hookOwnerHint}>{automationOwnerLabel(hook)}</span>,
        },
        {
          key: 'created',
          priority: 'secondary',
          header: text.created,
          render: (hook) => formatDate(hook.createdAt),
        },
        ...(canManage
          ? [
              {
                key: 'actions',
                priority: 'secondary' as const,
                header: text.actions,
                render: (hook: Hook) => (
                  <button
                    className="button small"
                    disabled={pending}
                    aria-label={`${hook.name}: ${hook.enabled ? text.automationDisable : text.automationEnable}`}
                    onClick={() => onToggle(hook)}
                  >
                    {hook.enabled ? text.automationDisable : text.automationEnable}
                  </button>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
