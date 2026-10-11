import { describe, expect, it } from 'vitest';
import { userMenuLinks } from './userMenuLinks';

const labels = (links: { label: string }[]) => links.map((link) => link.label);

describe('userMenuLinks', () => {
  it('ローカルアカウントには アカウント・パスワードの変更・全体設定 を出す', () => {
    expect(userMenuLinks({ authSources: ['local'] })).toEqual([
      { to: '/settings/account', label: 'アカウント' },
      { to: '/settings/account/password', label: 'パスワードの変更' },
      { to: '/settings/account', label: '全体設定', isSettingsEntry: true },
    ]);
  });

  it('SSO だけの利用者にはパスワードの変更を出さない', () => {
    expect(labels(userMenuLinks({ authSources: ['oidc'] }))).toEqual(['アカウント', '全体設定']);
  });

  it('全体管理の項目は無く、全体設定は全体管理者でなくても出る', () => {
    const links = userMenuLinks({ authSources: ['oidc', 'local'] });
    expect(labels(links)).not.toContain('全体管理');
    expect(links.filter((link) => link.to.startsWith('/admin'))).toEqual([]);
    expect(links.at(-1)).toMatchObject({ label: '全体設定', to: '/settings/account' });
  });
});
