import { describe, expect, it } from 'vitest';
import { navigationGroups, navigationLinks, projectHomePath } from './navigationLinks';
import { ADMIN_SECTION_LABELS, adminSectionPath, isAdminSection } from './adminSections';
import { text } from '../i18n/catalog';

const paths = (links: { to: string }[]) => links.map((link) => link.to);
const ADMIN_PATHS = [
  '/admin/projects',
  '/admin/users',
  '/admin/storage',
  '/admin/launchers',
  '/admin/audit',
];

describe('navigationLinks', () => {
  it('Project を開いた viewer には Plugins と全体管理を出さない', () => {
    const links = paths(
      navigationLinks({ projectId: 'p1', projectRole: 'viewer', isGlobalAdmin: false }),
    );
    expect(links[0]).toBe('/projects/p1/experiments');
    expect(links).toContain('/projects/p1/settings');
    // Every member may read the hooks; creating and switching them is checked on the page.
    expect(links).toContain('/projects/p1/hooks');
    expect(links).not.toContain('/projects/p1/plugins');
    expect(links.filter((link) => link.startsWith('/admin'))).toEqual([]);
  });

  it('Project admin には Plugins を出す', () => {
    const links = paths(
      navigationLinks({ projectId: 'p1', projectRole: 'admin', isGlobalAdmin: false }),
    );
    expect(links).toContain('/projects/p1/plugins');
  });

  it('Project を開いていない全体管理者には全体管理の5項目だけを出す', () => {
    expect(paths(navigationLinks({ isGlobalAdmin: true }))).toEqual(ADMIN_PATHS);
  });

  it('Project を開いていない一般ユーザーにはリンクが無い', () => {
    expect(navigationLinks({ isGlobalAdmin: false })).toEqual([]);
  });

  it('組は 記録・モデル・データ・実行・プロジェクト管理 の順で、全体管理者には最後に全体管理の組が付く', () => {
    const groups = navigationGroups({ projectId: 'p1', projectRole: 'admin', isGlobalAdmin: true });
    expect(groups.map((group) => group.label)).toEqual([
      text.navigationGroupTracking,
      text.navigationGroupModels,
      text.navigationGroupData,
      text.navigationGroupExecution,
      text.navigationGroupProjectManagement,
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
    expect(paths(groups[5]!.links)).toEqual(ADMIN_PATHS);
    // Every screen appears exactly once across the groups.
    expect(new Set(paths(groups.flatMap((group) => group.links))).size).toBe(14 + 5);
  });

  it('全体管理の項目名は ユーザー・ストレージ・ランチャー・監査ログ など各画面の見出しと同じ', () => {
    const [group] = navigationGroups({ isGlobalAdmin: true });
    expect(group!.label).toBe('全体管理');
    expect(group!.links.map((link) => link.label)).toEqual([
      'プロジェクト',
      'ユーザー',
      'ストレージ',
      'ランチャー',
      '監査ログ',
    ]);
    expect(group!.links.map((link) => link.label)).toEqual(Object.values(ADMIN_SECTION_LABELS));
  });

  it('プロジェクト設定の項目名は「プロジェクト設定」', () => {
    const links = navigationLinks({ projectId: 'p1', projectRole: 'viewer', isGlobalAdmin: false });
    expect(links.find((link) => link.screen === 'settings')?.label).toBe('プロジェクト設定');
  });
});

describe('全体管理の画面のパス', () => {
  it('各項目は /admin/<項目> で、知らない項目名は全体管理の画面ではない', () => {
    expect(adminSectionPath('storage')).toBe('/admin/storage');
    expect(isAdminSection('launchers')).toBe(true);
    expect(isAdminSection('settings')).toBe(false);
    expect(isAdminSection(undefined)).toBe(false);
  });

  it('Project はその Experiments で開く', () => {
    expect(projectHomePath('p1')).toBe('/projects/p1/experiments');
  });
});
