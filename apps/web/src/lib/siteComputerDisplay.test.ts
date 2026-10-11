import { describe, expect, it } from 'vitest';
import {
  failedCheck,
  launcher,
  ownedSiteDetails,
  personalSettings,
  readyKey,
} from '../../tests/fixtures/siteComputers';
import {
  isConnectionCheckInProgress,
  isKeyReady,
  isKeyRequested,
  launcherOptions,
  sharedAccountKey,
  shortSha256,
  targetOwnerLabel,
} from './siteComputerDisplay';

describe('コンピュータの所有者の表示', () => {
  it('所有者のいないものは全体、自分のものは自分、ほかの人のものはその名前と書き分ける', () => {
    expect(targetOwnerLabel({ ownerUserId: null, ownerName: null }, 'alice')).toBe('全体');
    expect(targetOwnerLabel(ownedSiteDetails, 'alice')).toBe('自分');
    expect(targetOwnerLabel(ownedSiteDetails, 'bob')).toBe('Alice');
    expect(targetOwnerLabel({ ownerUserId: 'carol', ownerName: null }, 'bob')).toBe('carol');
  });
});

describe('launcherの選択肢', () => {
  const revoked = { ...launcher, id: 'old', name: 'old', revokedAt: '2026-10-10T01:00:00Z' };

  it('失効したlauncherは、今のコンピュータのものだけを失効の印つきで残す', () => {
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

  it('接続確認ができるのは、launcherが作り終えた鍵だけ', () => {
    expect(isKeyReady(readyKey)).toBe(true);
    expect(isKeyReady({ ...readyKey, status: 'requested', publicKey: null })).toBe(false);
    expect(isKeyReady(null)).toBe(false);
    expect(isKeyReady(undefined)).toBe(false);
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
