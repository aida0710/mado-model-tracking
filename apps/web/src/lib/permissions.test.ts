import { describe, expect, it } from 'vitest';
import type { ProjectRole } from '@mmt/contracts';
import {
  canChangeOwnPassword,
  canControlSweep,
  canCreateProject,
  canEditProject,
  canManageAutomationRules,
  canManagePlugins,
  canManageProject,
  isGlobalAdmin,
} from './permissions';

const roles: ProjectRole[] = ['viewer', 'editor', 'admin'];

describe('Projectの権限判定', () => {
  it.each([
    ['viewer', false, false],
    ['editor', true, false],
    ['admin', true, true],
  ] as const)('%sは編集=%s、Project管理=%sになる', (role, canEdit, canManage) => {
    expect(canEditProject(role)).toBe(canEdit);
    expect(canManageProject(role)).toBe(canManage);
  });

  it.each(roles)('全体管理者は%sでもpluginと自動実行ルールを管理できる', (role) => {
    expect(canManagePlugins(role, true)).toBe(true);
    expect(canManageAutomationRules(role, true)).toBe(true);
  });

  it.each([
    ['viewer', false],
    ['editor', false],
    ['admin', true],
  ] as const)('全体管理者でない%sのplugin・ルール管理は%sになる', (role, expected) => {
    expect(canManagePlugins(role, false)).toBe(expected);
    expect(canManageAutomationRules(role, false)).toBe(expected);
  });

  it('参加していないProjectのpluginは全体管理者だけが管理できる', () => {
    expect(canManagePlugins(undefined, false)).toBe(false);
    expect(canManagePlugins(undefined, true)).toBe(true);
  });

  it('全体管理者でもProject roleの編集・管理判定は変わらない', () => {
    expect(isGlobalAdmin({ isAdmin: true })).toBe(true);
    expect(isGlobalAdmin({ isAdmin: false })).toBe(false);
    expect(canManageProject('viewer')).toBe(false);
  });

  it('無効化されたユーザーはProjectを作成できない', () => {
    expect(canCreateProject({ status: 'active' })).toBe(true);
    expect(canCreateProject({ status: 'disabled' })).toBe(false);
  });

  it.each([
    [['local'], true],
    [['local', 'oidc'], true],
    [['oidc'], false],
    [[], false],
  ] as const)('ログイン手段が%sならパスワード変更=%sになる', (authSources, expected) => {
    expect(canChangeOwnPassword({ authSources: [...authSources] })).toBe(expected);
  });

  it.each([
    ['viewer', 'creator', false],
    ['editor', 'creator', true],
    ['editor', 'other', false],
    ['admin', 'other', true],
  ] as const)('Sweepの操作は%s（%s）なら%sになる', (role, userId, expected) => {
    expect(canControlSweep(role, userId, { createdBy: 'creator' })).toBe(expected);
  });
});
