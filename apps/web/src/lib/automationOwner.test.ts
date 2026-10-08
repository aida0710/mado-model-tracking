import { describe, expect, it } from 'vitest';
import type { ServiceAccount } from '@mmt/contracts';
import { automationOwnerLabel, automationOwnerOptions } from './automationOwner';

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

describe('ruleの所有者', () => {
  it('移管先には有効なrole adminのService Accountだけを、今の所有者を除いて出す', () => {
    const accounts = [
      account({ id: 'bot' }),
      account({ id: 'current' }),
      account({ id: 'editor-bot', role: 'editor' }),
      account({ id: 'disabled-bot', status: 'disabled' }),
    ];
    expect(automationOwnerOptions(accounts, { runAsUserId: 'current' })).toEqual([
      { value: 'bot', label: 'bot' },
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
