import { describe, expect, it } from 'vitest';
import type { ServiceAccount } from '@mmt/contracts';
import {
  HOOK_OWNER_ROLES,
  RULE_OWNER_ROLES,
  automationOwnerLabel,
  serviceAccountOwnerOptions,
} from './automationOwner';

function account(overrides: Partial<ServiceAccount> & Pick<ServiceAccount, 'id'>): ServiceAccount {
  return {
    projectId: 'project',
    name: overrides.id,
    description: '',
    role: 'admin',
    status: 'active',
    createdAt: '2026-10-08T00:00:00Z',
    ...overrides,
  };
}

describe('ruleとフックの所有者', () => {
  const accounts = [
    account({ id: 'bot' }),
    account({ id: 'current' }),
    account({ id: 'editor-bot', role: 'editor' }),
    account({ id: 'viewer-bot', role: 'viewer' }),
    account({ id: 'no-role-bot', role: null }),
    account({ id: 'disabled-bot', status: 'disabled' }),
  ];

  it('ruleの移管先には有効なrole adminのService Accountだけを、今の所有者を除いて出す', () => {
    expect(
      serviceAccountOwnerOptions(accounts, { runAsUserId: 'current', roles: RULE_OWNER_ROLES }),
    ).toEqual([{ value: 'bot', label: 'bot' }]);
  });

  it('フックの移管先にはrole editorのService Accountも出す', () => {
    expect(
      serviceAccountOwnerOptions(accounts, { runAsUserId: 'current', roles: HOOK_OWNER_ROLES }),
    ).toEqual([
      { value: 'bot', label: 'bot' },
      { value: 'editor-bot', label: 'editor-bot' },
    ]);
  });

  it('所有者は人かService Accountかを添えて表示し、名前が無ければIDを出す', () => {
    expect(
      automationOwnerLabel({
        runAsUserId: 'sa',
        runAsKind: 'service',
        runAsName: 'automation-bot',
      }),
    ).toBe('automation-bot（Service Account）');
    expect(automationOwnerLabel({ runAsUserId: 'user-1' })).toBe('user-1（人）');
  });
});
