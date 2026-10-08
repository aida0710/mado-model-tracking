import type { ProjectRole } from '@mmt/contracts';

export function canManageAutomationRules(role: ProjectRole, isGlobalAdmin: boolean): boolean {
  return isGlobalAdmin || role === 'admin';
}
