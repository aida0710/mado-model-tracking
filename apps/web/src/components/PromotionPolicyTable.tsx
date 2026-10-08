import type { Model, ModelAutomationRule, PromotionPolicy, ServiceAccount } from '@mmt/contracts';
import { DataTable } from './DataTable';
import { summarizeCriterion } from '../lib/promotionPolicyInput';
import { text } from '../i18n/catalog';

// The run-as user is the creator until a Project admin moves it to a Service Account.
function ownerLabel(policy: PromotionPolicy, serviceAccounts: ServiceAccount[]): string {
  if (policy.runAsUserId === policy.createdBy) return text.promotionPolicyOwnerCreator;
  return (
    serviceAccounts.find((account) => account.id === policy.runAsUserId)?.name ??
    text.promotionPolicyOwnerServiceAccount
  );
}

export function PromotionPolicyTable({
  policies,
  models,
  rules,
  serviceAccounts,
  selectedPolicyId,
  canManage,
  pending,
  onSelect,
  onSetEnabled,
  onTransferOwner,
}: {
  policies: PromotionPolicy[];
  models: Model[];
  rules: ModelAutomationRule[];
  /** Names the Service Account owners; empty for users who cannot list the accounts. */
  serviceAccounts: ServiceAccount[];
  selectedPolicyId: string;
  canManage: boolean;
  pending: boolean;
  onSelect: (id: string) => void;
  onSetEnabled: (id: string, enabled: boolean) => void;
  onTransferOwner: (policy: PromotionPolicy) => void;
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
        {
          key: 'owner',
          label: text.promotionPolicyOwner,
          render: (policy) => ownerLabel(policy, serviceAccounts),
        },
        ...(canManage
          ? [
              {
                key: 'actions',
                label: text.details,
                render: (policy: PromotionPolicy) => (
                  <div className="access-actions">
                    <button
                      className="button small"
                      disabled={pending}
                      aria-label={`${policy.name}: ${policy.enabled ? text.automationDisable : text.automationEnable}`}
                      onClick={() => onSetEnabled(policy.id, !policy.enabled)}
                    >
                      {policy.enabled ? text.automationDisable : text.automationEnable}
                    </button>
                    <button
                      className="button small"
                      aria-label={`${policy.name}: ${text.promotionTransferOwner}`}
                      onClick={() => onTransferOwner(policy)}
                    >
                      {text.promotionTransferOwner}
                    </button>
                  </div>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
