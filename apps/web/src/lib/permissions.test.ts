import { describe, expect, it } from 'vitest';
import type { ProjectRole } from '@mmt/contracts';
import {
  canAddGlobalTarget,
  canAddTarget,
  canChangeOwnPassword,
  canControlSweep,
  canManageHooks,
  canManageTarget,
  canTransferHookOwners,
  canCreateProject,
  canEditProject,
  canManageAutomationRules,
  canManagePlugins,
  canManageProject,
  isGlobalAdmin,
  isTargetOwner,
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

describe('フックの権限判定', () => {
  it.each([
    ['viewer', false],
    ['editor', true],
    ['admin', true],
  ] as const)('%sのフックの作成・有効と無効の切り替え・手動の起動は%sになる', (role, expected) => {
    expect(canManageHooks(role)).toBe(expected);
  });

  it.each([
    ['viewer', false, false],
    ['editor', false, false],
    ['admin', false, true],
    ['viewer', true, true],
  ] as const)('%s（全体管理者=%s）のフックの所有者の移管は%sになる', (role, globalAdmin, expected) => {
    expect(canTransferHookOwners(role, globalAdmin)).toBe(expected);
  });
});

describe('計算機の権限判定', () => {
  const ownedByAlice = { ownerUserId: 'alice' };
  const global = { ownerUserId: null };

  it('サインインしている人は誰でも自分の計算機を追加でき、全体の計算機は全体管理者だけが追加する', () => {
    expect(canAddTarget({ status: 'active' })).toBe(true);
    expect(canAddTarget({ status: 'disabled' })).toBe(false);
    expect(canAddGlobalTarget({ isAdmin: true })).toBe(true);
    expect(canAddGlobalTarget({ isAdmin: false })).toBe(false);
  });

  it.each([
    ['研究者の計算機の所有者', true, { id: 'alice', isAdmin: false }, ownedByAlice],
    ['研究者の計算機の所有者でない研究者', false, { id: 'bob', isAdmin: false }, ownedByAlice],
    ['研究者の計算機の全体管理者', true, { id: 'admin', isAdmin: true }, ownedByAlice],
    ['全体の計算機の研究者', false, { id: 'alice', isAdmin: false }, global],
    ['全体の計算機の全体管理者', true, { id: 'admin', isAdmin: true }, global],
  ] as const)('%sは管理（編集・job shell・共用の鍵・全員の設定）=%s', (_who, expected, user, target) => {
    expect(canManageTarget(user, target)).toBe(expected);
  });

  it('所有者は自分が足した計算機の持ち主だけで、全体管理者でも全体の計算機の所有者ではない', () => {
    expect(isTargetOwner({ id: 'alice' }, ownedByAlice)).toBe(true);
    expect(isTargetOwner({ id: 'admin' }, ownedByAlice)).toBe(false);
    expect(isTargetOwner({ id: 'admin' }, global)).toBe(false);
  });
});
