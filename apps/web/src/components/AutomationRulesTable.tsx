import { Link } from 'react-router-dom';
import type { ModelAutomationRule } from '@mmt/contracts';
import type { AutomationCatalog } from '../types/modelAutomation';
import { ResponsiveTable } from './ResponsiveTable';
import { buildCatalogOptions } from '../lib/catalogOptions';
import { text } from '../i18n/catalog';
import { automationText, automationTriggerLabels } from '../i18n/automation';

export function AutomationRulesTable({
  rules,
  projectId,
  catalog,
  selectedRuleId,
  canManage,
  pending,
  onSelect,
  onSetEnabled,
}: {
  rules: ModelAutomationRule[];
  projectId: string;
  catalog?: AutomationCatalog;
  selectedRuleId: string;
  canManage: boolean;
  pending: boolean;
  onSelect: (id: string) => void;
  onSetEnabled: (id: string, enabled: boolean) => void;
}) {
  const codeOptions = catalog ? buildCatalogOptions(catalog.registry).codes : [];
  return (
    <ResponsiveTable
      rows={rules}
      rowKey={(rule) => rule.id}
      selectedKey={selectedRuleId}
      empty={text.automationNoRules}
      columns={[
        {
          key: 'name',
          priority: 'primary',
          header: text.name,
          render: (rule) => (
            <button className="link-button" onClick={() => onSelect(rule.id)}>
              {rule.name}
            </button>
          ),
        },
        {
          key: 'enabled',
          priority: 'primary',
          header: text.status,
          render: (rule) => (
            <span className={rule.enabled ? 'automation-enabled' : 'muted'}>
              {rule.enabled ? text.enabled : text.disabled}
            </span>
          ),
        },
        {
          key: 'families',
          priority: 'secondary',
          header: text.family,
          className: 'mono',
          render: (rule) => rule.modelFamilies.join(', '),
        },
        { key: 'kind', priority: 'secondary', header: text.kind, render: (rule) => text[rule.kind] },
        {
          key: 'trigger',
          priority: 'secondary',
          header: automationText.trigger,
          render: (rule) => {
            if (rule.trigger !== 'upstream_run_finished')
              return automationTriggerLabels[rule.trigger];
            const upstream = rules.find((item) => item.id === rule.upstreamRuleId);
            return (
              <span>
                {`${automationText.upstreamRule}: `}
                <button
                  className="link-button"
                  onClick={() => rule.upstreamRuleId && onSelect(rule.upstreamRuleId)}
                >
                  {upstream?.name ?? rule.upstreamRuleId}
                </button>
              </span>
            );
          },
        },
        {
          key: 'code',
          priority: 'secondary',
          header: text.codeVersion,
          render: (rule) => (
            <Link to={`/projects/${projectId}/codes?version=${rule.codeVersionId}`}>
              {codeOptions.find((option) => option.value === rule.codeVersionId)?.label ??
                rule.codeVersionId}
            </Link>
          ),
        },
        {
          key: 'target',
          priority: 'secondary',
          header: text.target,
          render: (rule) =>
            catalog?.targets.find((target) => target.id === rule.targetId)?.name ?? rule.targetId,
        },
        ...(canManage
          ? [
              {
                key: 'actions',
                priority: 'secondary' as const,
                header: text.details,
                render: (rule: ModelAutomationRule) => (
                  <button
                    className="button small"
                    disabled={pending}
                    aria-label={`${rule.name}: ${rule.enabled ? text.automationDisable : text.automationEnable}`}
                    onClick={() => onSetEnabled(rule.id, !rule.enabled)}
                  >
                    {rule.enabled ? text.automationDisable : text.automationEnable}
                  </button>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
