import { describe, expect, it } from 'vitest';
import type { ProjectGroupBinding } from '@mmt/contracts';
import { findExistingGroupBinding } from './groupBindingInput';

const binding = (group: string, role: ProjectGroupBinding['role']): ProjectGroupBinding => ({
  projectId: 'project-1',
  group,
  role,
  createdBy: null,
  createdAt: '2026-10-08T00:00:00Z',
});

describe('groupの追加で登録済みの名前を見つける', () => {
  const bindings = [binding('mmt-admins', 'admin'), binding('mmt-users', 'viewer')];

  it('前後の空白を除いて同じ名前なら、上書きされる登録を返す', () => {
    expect(findExistingGroupBinding(bindings, ' mmt-admins ')).toMatchObject({ role: 'admin' });
  });

  it('大文字と小文字が違う名前は、Authentikでは別のgroupなので登録済みとしない', () => {
    expect(findExistingGroupBinding(bindings, 'MMT-ADMINS')).toBeUndefined();
    expect(findExistingGroupBinding(bindings, 'mmt-new')).toBeUndefined();
  });
});
