import { describe, expect, it } from 'vitest';
import {
  failedCheck,
  globalSiteDetails,
  launcher,
  ownedSiteDetails,
  personalSettings,
  readyKey,
} from '../../tests/fixtures/siteComputers';
import {
  isConnectionCheckInProgress,
  isKeyRequested,
  launcherOptions,
  shareableProjectOptions,
  sharedAccountKey,
  shortSha256,
  targetOwnerLabel,
  targetSharingLabel,
} from './siteComputerDisplay';

const projects = [
  { id: 'project', name: 'Speech', role: 'editor' as const },
  { id: 'viewed', name: 'Vision', role: 'viewer' as const },
  { id: 'managed', name: 'Music', role: 'admin' as const },
];

describe('計算機の所有者と共有先の表示', () => {
  it('全体の計算機・自分の計算機・ほかの人の計算機を書き分ける', () => {
    expect(targetOwnerLabel(globalSiteDetails, 'alice')).toBe('全体の計算機');
    expect(targetOwnerLabel(ownedSiteDetails, 'alice')).toBe('自分の計算機');
    expect(targetOwnerLabel(ownedSiteDetails, 'bob')).toBe('Aliceさんの計算機');
    expect(targetOwnerLabel({ ownerUserId: 'carol', ownerName: null }, 'bob')).toBe('carolさんの計算機');
  });

  it('共有先はProjectの名前で出し、見られない人にはnull、共有していなければ本人だけと出す', () => {
    expect(targetSharingLabel(globalSiteDetails, projects, false)).toBe('すべてのProject');
    expect(targetSharingLabel(ownedSiteDetails, projects, true)).toBe('Speech');
    expect(targetSharingLabel({ ...ownedSiteDetails, projectIds: ['project', 'gone'] }, projects, true)).toBe(
      'Speech, gone',
    );
    expect(targetSharingLabel({ ...ownedSiteDetails, projectIds: [] }, projects, true)).toBe(
      '共有なし（本人だけ）',
    );
    expect(targetSharingLabel(ownedSiteDetails, projects, false)).toBeNull();
  });

  it('共有できるのはEditor以上のProjectと、すでに共有しているProject', () => {
    expect(shareableProjectOptions(projects, [])).toEqual([
      { value: 'project', label: 'Speech' },
      { value: 'managed', label: 'Music' },
    ]);
    expect(shareableProjectOptions(projects, ['viewed']).map((option) => option.value)).toEqual([
      'project',
      'managed',
      'viewed',
    ]);
  });
});

describe('launcherの選択肢', () => {
  const revoked = { ...launcher, id: 'old', name: 'old', revokedAt: '2026-10-10T01:00:00Z' };

  it('失効したlauncherは、今の計算機のものだけを失効の印つきで残す', () => {
    expect(launcherOptions([launcher, revoked], '')).toEqual([{ value: 'launcher', label: 'main' }]);
    expect(launcherOptions([launcher, revoked], 'old')).toEqual([
      { value: 'launcher', label: 'main' },
      { value: 'old', label: 'old（失効）' },
    ]);
  });

  it('一覧に無い（全体管理者にしか見えない失効した）launcherはIDで残す', () => {
    expect(launcherOptions([launcher], 'hidden')).toEqual([
      { value: 'launcher', label: 'main' },
      { value: 'hidden', label: 'hidden（失効）' },
    ]);
  });
});

describe('鍵と接続確認の状態', () => {
  it('共用アカウントの鍵はuserIdの無い鍵で、作成待ちの鍵だけをrequestedと見る', () => {
    const personalKey = personalSettings.key!;
    expect(sharedAccountKey([personalKey, readyKey])).toBe(readyKey);
    expect(sharedAccountKey([personalKey])).toBeNull();
    expect(isKeyRequested({ ...readyKey, status: 'requested', publicKey: null })).toBe(true);
    expect(isKeyRequested(readyKey)).toBe(false);
    expect(isKeyRequested(null)).toBe(false);
  });

  it('一番新しい確認がlauncherの答えを待っている間だけ確認中とする', () => {
    expect(isConnectionCheckInProgress([{ ...failedCheck, status: 'queued' }, failedCheck])).toBe(true);
    expect(isConnectionCheckInProgress([failedCheck, { ...failedCheck, status: 'queued' }])).toBe(false);
    expect(isConnectionCheckInProgress([])).toBe(false);
  });

  it('job shellのSHA-256は表で見分けられる長さに縮める', () => {
    expect(shortSha256('0123456789abcdef'.repeat(4))).toBe('0123456789ab');
  });
});
