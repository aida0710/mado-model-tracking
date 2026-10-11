import { describe, expect, it } from 'vitest';
import { canOpenTargetDetails, launcherStatusLabel } from './computeTargetOverview';
import {
  automaticSiteOverview,
  ownSiteOverview,
  privatePcOverview,
  publicSshOverview,
} from '../../tests/fixtures/computers';

describe('全体設定のコンピュータの行', () => {
  it('使えるか管理できる行だけが詳細を開く', () => {
    expect(canOpenTargetDetails(publicSshOverview)).toBe(true);
    expect(canOpenTargetDetails(privatePcOverview)).toBe(false);
    expect(canOpenTargetDetails({ ...privatePcOverview, canManage: true })).toBe(true);
  });

  it('自動投入のsiteだけにランチャーの状態を出し、未設定・失効・応答なしを書き分ける', () => {
    expect(launcherStatusLabel(publicSshOverview)).toBeNull();
    expect(launcherStatusLabel(privatePcOverview)).toBeNull();
    expect(launcherStatusLabel(ownSiteOverview)).toBe('ランチャー未設定');
    expect(launcherStatusLabel(automaticSiteOverview)).toMatch(/^main（最終応答 .+）$/);
    const launcher = automaticSiteOverview.launcher!;
    expect(
      launcherStatusLabel({ ...automaticSiteOverview, launcher: { ...launcher, revoked: true } }),
    ).toBe('ランチャーは失効');
    expect(
      launcherStatusLabel({ ...automaticSiteOverview, launcher: { ...launcher, lastSeenAt: null } }),
    ).toBe('ランチャーの応答なし');
  });
});
