import { describe, expect, it } from 'vitest';
import { settingsPathForLegacyPath } from './legacySettingsPaths';

describe('settingsPathForLegacyPath', () => {
  it('/account と /account/password は全体設定のアカウントへ移る', () => {
    expect(settingsPathForLegacyPath('/account')).toBe('/settings/account');
    expect(settingsPathForLegacyPath('/account/password')).toBe('/settings/account/password');
  });

  it('/admin は以前と同じくプロジェクトの一覧（/settings/projects）へ移る', () => {
    expect(settingsPathForLegacyPath('/admin')).toBe('/settings/projects');
    expect(settingsPathForLegacyPath('/admin/')).toBe('/settings/projects');
  });

  it('/admin/<項目> は /settings/<項目> へ移り、知らない項目名はプロジェクトの一覧へ移る', () => {
    expect(settingsPathForLegacyPath('/admin/users')).toBe('/settings/users');
    expect(settingsPathForLegacyPath('/admin/storage')).toBe('/settings/storage');
    expect(settingsPathForLegacyPath('/admin/launchers')).toBe('/settings/launchers');
    expect(settingsPathForLegacyPath('/admin/audit')).toBe('/settings/audit');
    expect(settingsPathForLegacyPath('/admin/unknown')).toBe('/settings/projects');
  });

  it('旧 URL でないパスは移さない', () => {
    expect(settingsPathForLegacyPath('/settings/account')).toBeUndefined();
    expect(settingsPathForLegacyPath('/projects/p1/settings')).toBeUndefined();
    expect(settingsPathForLegacyPath('/administration')).toBeUndefined();
    expect(settingsPathForLegacyPath('/admin/users/u1')).toBeUndefined();
  });
});
