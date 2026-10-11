import { describe, expect, it } from 'vitest';
import { navigationGroups, navigationLinks, projectHomePath } from './navigationLinks';
import {
  isAdminSection,
  PASSWORD_CHANGE_PATH,
  SETTINGS_SECTION_LABELS,
  settingsSectionPath,
} from './settingsSections';
import { text } from '../i18n/catalog';

const paths = (links: { to: string }[]) => links.map((link) => link.to);
const GENERAL_SETTINGS_PATHS = ['/settings/account', '/settings/computers'];
const ADMIN_PATHS = [
  '/settings/projects',
  '/settings/users',
  '/settings/storage',
  '/settings/launchers',
  '/settings/audit',
];

describe('navigationLinks', () => {
  it('Project を開いた viewer には Plugins と全体管理を出さず、全体設定は出す', () => {
    const links = paths(
      navigationLinks({ projectId: 'p1', projectRole: 'viewer', isGlobalAdmin: false }),
    );
    expect(links[0]).toBe('/projects/p1/experiments');
    expect(links).toContain('/projects/p1/settings');
    // Every member may read the hooks; creating and switching them is checked on the page.
    expect(links).toContain('/projects/p1/hooks');
    expect(links).not.toContain('/projects/p1/plugins');
    expect(links.filter((link) => link.startsWith('/settings/'))).toEqual(GENERAL_SETTINGS_PATHS);
  });

  it('Project admin には Plugins を出す', () => {
    const links = paths(
      navigationLinks({ projectId: 'p1', projectRole: 'admin', isGlobalAdmin: false }),
    );
    expect(links).toContain('/projects/p1/plugins');
  });

  it('Project を開いていない一般利用者には全体設定の組（アカウント・コンピュータ）だけを出す', () => {
    const groups = navigationGroups({ isGlobalAdmin: false });
    expect(groups.map((group) => group.label)).toEqual(['全体設定']);
    expect(groups[0]!.links).toEqual([
      { screen: 'account', to: '/settings/account', label: 'アカウント' },
      { screen: 'computers', to: '/settings/computers', label: 'コンピュータ' },
    ]);
  });

  it('Project を開いていない全体管理者には全体設定と全体管理の組を出す', () => {
    const groups = navigationGroups({ isGlobalAdmin: true });
    expect(groups.map((group) => group.label)).toEqual(['全体設定', '全体管理']);
    expect(paths(groups[0]!.links)).toEqual(GENERAL_SETTINGS_PATHS);
    expect(paths(groups[1]!.links)).toEqual(ADMIN_PATHS);
  });

  it('組は 記録・モデル・データ・実行・プロジェクト管理 の順で、最後に全体設定、全体管理者には全体管理が付く', () => {
    const groups = navigationGroups({ projectId: 'p1', projectRole: 'admin', isGlobalAdmin: true });
    expect(groups.map((group) => group.label)).toEqual([
      text.navigationGroupTracking,
      text.navigationGroupModels,
      text.navigationGroupData,
      text.navigationGroupExecution,
      text.navigationGroupProjectManagement,
      text.globalSettings,
      text.administration,
    ]);
    expect(paths(groups[0]!.links)).toEqual([
      '/projects/p1/experiments',
      '/projects/p1/sweeps',
      '/projects/p1/reports',
    ]);
    expect(groups[4]!.links).toEqual([
      { screen: 'plugins', to: '/projects/p1/plugins', label: text.plugins },
      { screen: 'settings', to: '/projects/p1/settings', label: text.settings },
    ]);
    expect(paths(groups[5]!.links)).toEqual(GENERAL_SETTINGS_PATHS);
    expect(paths(groups[6]!.links)).toEqual(ADMIN_PATHS);
    // Every screen appears exactly once across the groups.
    expect(new Set(paths(groups.flatMap((group) => group.links))).size).toBe(14 + 2 + 5);
  });

  it('Project を開いた一般利用者の最後の組は全体設定で、全体管理の組は無い', () => {
    const groups = navigationGroups({
      projectId: 'p1',
      projectRole: 'editor',
      isGlobalAdmin: false,
    });
    expect(groups.at(-1)!.label).toBe(text.globalSettings);
    expect(groups.map((group) => group.label)).not.toContain(text.administration);
  });

  it('全体管理の項目名は ユーザー・ストレージ・ランチャー・監査ログ など各画面の見出しと同じ', () => {
    const [, group] = navigationGroups({ isGlobalAdmin: true });
    expect(group!.label).toBe('全体管理');
    expect(group!.links.map((link) => link.label)).toEqual([
      'プロジェクト',
      'ユーザー',
      'ストレージ',
      'ランチャー',
      '監査ログ',
    ]);
    const labels = navigationLinks({ isGlobalAdmin: true }).map((link) => link.label);
    expect(labels).toEqual(Object.values(SETTINGS_SECTION_LABELS));
  });

  it('プロジェクト設定の項目名は「プロジェクト設定」', () => {
    const links = navigationLinks({ projectId: 'p1', projectRole: 'viewer', isGlobalAdmin: false });
    expect(links.find((link) => link.screen === 'settings')?.label).toBe('プロジェクト設定');
  });
});

describe('全体設定の画面のパス', () => {
  it('各項目は /settings/<項目> で、パスワードの変更はアカウントの下にある', () => {
    expect(settingsSectionPath('storage')).toBe('/settings/storage');
    expect(settingsSectionPath('computers')).toBe('/settings/computers');
    expect(PASSWORD_CHANGE_PATH).toBe('/settings/account/password');
  });

  it('全体管理の項目だけが全体管理の画面で、全体設定の項目と知らない名前は含まない', () => {
    expect(isAdminSection('launchers')).toBe(true);
    expect(isAdminSection('account')).toBe(false);
    expect(isAdminSection('computers')).toBe(false);
    expect(isAdminSection('settings')).toBe(false);
    expect(isAdminSection(undefined)).toBe(false);
  });

  it('Project はその Experiments で開く', () => {
    expect(projectHomePath('p1')).toBe('/projects/p1/experiments');
  });
});
