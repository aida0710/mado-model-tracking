import type { ModelAutomationRule, ServiceAccount } from '@mmt/contracts';
import type { SelectOption } from '../types/form';
import { automationText } from '../i18n/automation';

/**
 * Service Accounts a rule can be moved to: active Project admins (what running a rule requires),
 * except the current owner. The API applies the same check.
 */
export function automationOwnerOptions(
  accounts: readonly ServiceAccount[],
  rule: Pick<ModelAutomationRule, 'runAsUserId'>,
): SelectOption[] {
  return accounts
    .filter(
      (account) =>
        account.status === 'active' && account.role === 'admin' && account.id !== rule.runAsUserId,
    )
    .map((account) => ({ value: account.id, label: account.name }));
}

/** The owner as a person or a Service Account; the id stands in when the name is unknown. */
export function automationOwnerLabel(
  rule: Pick<ModelAutomationRule, 'runAsUserId' | 'runAsKind' | 'runAsName'>,
): string {
  const name = rule.runAsName || rule.runAsUserId;
  return rule.runAsKind === 'service'
    ? automationText.ownerServiceAccount(name)
    : automationText.ownerHuman(name);
}
