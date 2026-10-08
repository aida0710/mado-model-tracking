import type { Model, ModelAutomationRule, PromotionPolicy } from '@mmt/contracts';
import { DataTable } from './DataTable';
import { summarizeCriterion } from '../lib/promotionPolicyInput';
import { text } from '../i18n/catalog';

export function PromotionPolicyTable({
  policies,
  models,
  rules,
  selectedPolicyId,
  canManage,
  pending,
  onSelect,
  onSetEnabled,
}: {
  policies: PromotionPolicy[];
  models: Model[];
  rules: ModelAutomationRule[];
  selectedPolicyId: string;
  canManage: boolean;
  pending: boolean;
  onSelect: (id: string) => void;
  onSetEnabled: (id: string, enabled: boolean) => void;
}) {
  return (
    <DataTable
      items={policies}
      rowKey={(policy) => policy.id}
      selectedKey={selectedPolicyId}
      empty={text.promotionPoliciesEmpty}
      columns={[
        {
          key: 'name',
          label: text.name,
          render: (policy) => (
            <button className="link-button" onClick={() => onSelect(policy.id)}>
              {policy.name}
            </button>
          ),
        },
        {
          key: 'enabled',
          label: text.status,
          render: (policy) => (
            <span className={policy.enabled ? 'automation-enabled' : 'muted'}>
              {policy.enabled ? text.enabled : text.disabled}
            </span>
          ),
        },
        {
          key: 'model',
          label: text.promotionModel,
          render: (policy) =>
            models.find((model) => model.id === policy.modelId)?.name ?? policy.modelId,
        },
        {
          key: 'targetAlias',
          label: text.promotionTargetAlias,
          className: 'mono',
          render: (policy) => policy.targetAlias,
        },
        {
          key: 'baselineAlias',
          label: text.baselineAlias,
          className: 'mono',
          render: (policy) => policy.baselineAlias,
        },
        {
          key: 'evaluationRule',
          label: text.evaluationRule,
          render: (policy) =>
            rules.find((rule) => rule.id === policy.evaluationRuleId)?.name ??
            policy.evaluationRuleId,
        },
        {
          key: 'criteria',
          label: text.promotionCriteria,
          render: (policy) => (
            <ul className="promotion-criterion-results">
              {policy.criteria.map((criterion, index) => (
                <li key={`${criterion.metric}-${index}`} className="mono">
                  {summarizeCriterion(criterion)}
                </li>
              ))}
            </ul>
          ),
        },
        {
          key: 'autoPromote',
          label: text.promotionAutoPromoteColumn,
          render: (policy) =>
            policy.autoPromote ? text.promotionAutoPromoteOn : text.promotionAutoPromoteOff,
        },
        ...(canManage
          ? [
              {
                key: 'actions',
                label: text.details,
                render: (policy: PromotionPolicy) => (
                  <button
                    className="button small"
                    disabled={pending}
                    aria-label={`${policy.name}: ${policy.enabled ? text.automationDisable : text.automationEnable}`}
                    onClick={() => onSetEnabled(policy.id, !policy.enabled)}
                  >
                    {policy.enabled ? text.automationDisable : text.automationEnable}
                  </button>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
