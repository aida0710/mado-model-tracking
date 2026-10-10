import type { ProjectRole, ServiceAccount } from '@mmt/contracts';
import type { SelectOption } from '../types/form';
import { automationText } from '../i18n/automation';

// What the owner needs to start Jobs (the API checks the same): running a rule needs a Project
// admin, starting a hook an editor.
export const RULE_OWNER_ROLES = ['admin'] as const;
export const HOOK_OWNER_ROLES = ['editor', 'admin'] as const;

/** Service Accounts a rule or hook can be moved to: active ones with a role it needs. */
export function serviceAccountOwnerOptions(
  accounts: readonly ServiceAccount[],
  subject: { runAsUserId: string; roles: readonly ProjectRole[] },
): SelectOption[] {
  return accounts
    .filter(
      (account) =>
        account.status === 'active' &&
        account.role !== null &&
        subject.roles.includes(account.role) &&
        account.id !== subject.runAsUserId,
    )
    .map((account) => ({ value: account.id, label: account.name }));
}

/** The owner as a person or a Service Account; the id stands in when the name is unknown. */
export function automationOwnerLabel(
  owner: { runAsUserId: string; runAsKind?: 'human' | 'service'; runAsName?: string },
): string {
  const name = owner.runAsName || owner.runAsUserId;
  return owner.runAsKind === 'service'
    ? automationText.ownerServiceAccount(name)
    : automationText.ownerHuman(name);
}
