import { Link } from 'react-router-dom';
import type { ModelAutomationRule } from '@mmt/contracts';
import type { AutomationCatalog } from '../types/modelAutomation';
import { DataTable } from './DataTable';
import { buildCatalogOptions } from '../lib/catalogOptions';
import { text } from '../i18n/catalog';

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
    <DataTable
      items={rules}
      rowKey={(rule) => rule.id}
      selectedKey={selectedRuleId}
      empty={text.automationNoRules}
      columns={[
        {
          key: 'name',
          label: text.name,
          render: (rule) => (
            <button className="link-button" onClick={() => onSelect(rule.id)}>
              {rule.name}
            </button>
          ),
        },
        {
          key: 'enabled',
          label: text.status,
          render: (rule) => (
            <span className={rule.enabled ? 'automation-enabled' : 'muted'}>
              {rule.enabled ? text.enabled : text.disabled}
            </span>
          ),
        },
        {
          key: 'families',
          label: text.family,
          className: 'mono',
          render: (rule) => rule.modelFamilies.join(', '),
        },
        { key: 'kind', label: text.kind, render: (rule) => text[rule.kind] },
        {
          key: 'code',
          label: text.codeVersion,
          render: (rule) => (
            <Link to={`/projects/${projectId}/codes?version=${rule.codeVersionId}`}>
              {codeOptions.find((option) => option.value === rule.codeVersionId)?.label ??
                rule.codeVersionId}
            </Link>
          ),
        },
        {
          key: 'target',
          label: text.target,
          render: (rule) =>
            catalog?.targets.find((target) => target.id === rule.targetId)?.name ?? rule.targetId,
        },
        ...(canManage
          ? [
              {
                key: 'actions',
                label: text.details,
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
