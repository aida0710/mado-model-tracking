import { describe, expect, it } from 'vitest';
import { ADMIN_PATH, navigationGroups, navigationLinks } from './navigationLinks';
import { text } from '../i18n/catalog';

const paths = (links: { to: string }[]) => links.map((link) => link.to);

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
    expect(links).not.toContain(ADMIN_PATH);
  });

  it('Project admin には Plugins を出す', () => {
    const links = paths(
      navigationLinks({ projectId: 'p1', projectRole: 'admin', isGlobalAdmin: false }),
    );
    expect(links).toContain('/projects/p1/plugins');
  });

  it('Project を開いていない全体管理者には全体管理だけを出す', () => {
    expect(paths(navigationLinks({ isGlobalAdmin: true }))).toEqual([ADMIN_PATH]);
  });

  it('Project を開いていない一般ユーザーにはリンクが無い', () => {
    expect(navigationLinks({ isGlobalAdmin: false })).toEqual([]);
  });

  it('サイドバーとドロワーの組は 記録・モデル・データ・実行・管理 の順で、全体管理は管理の最後に入る', () => {
    const groups = navigationGroups({ projectId: 'p1', projectRole: 'admin', isGlobalAdmin: true });
    expect(groups.map((group) => group.label)).toEqual([
      text.navigationGroupTracking,
      text.navigationGroupModels,
      text.navigationGroupData,
      text.navigationGroupExecution,
      text.navigationGroupManagement,
    ]);
    expect(paths(groups[0]!.links)).toEqual([
      '/projects/p1/experiments',
      '/projects/p1/sweeps',
      '/projects/p1/reports',
    ]);
    expect(paths(groups.at(-1)!.links)).toEqual([
      '/projects/p1/plugins',
      '/projects/p1/settings',
      ADMIN_PATH,
    ]);
    // Every Project screen appears exactly once across the groups.
    expect(new Set(paths(groups.flatMap((group) => group.links))).size).toBe(15);
  });

  it('Project を開いていない全体管理者には管理の組だけを出す', () => {
    expect(navigationGroups({ isGlobalAdmin: true })).toEqual([
      {
        label: text.navigationGroupManagement,
        links: [{ screen: 'administration', to: ADMIN_PATH, label: text.administration }],
      },
    ]);
  });
});
