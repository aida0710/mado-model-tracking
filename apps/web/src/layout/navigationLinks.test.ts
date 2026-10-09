import { describe, expect, it } from 'vitest';
import { ADMIN_PATH, navigationLinks } from './navigationLinks';

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
});
