import { describe, expect, it } from 'vitest';
import { queuedJob, siteTarget } from '../../tests/fixtures/execution';
import {
  isWaitingManualSubmission,
  manualSiteOwnership,
  manualSubmissionGroups,
  manualSubmitCommand,
  OWNER_SUBMIT_OPTIONS,
} from './manualSubmission';

const waiting = { ...queuedJob, targetId: siteTarget.id, phase: 'waiting_manual' as const };
// A global manual site, and a researcher's PC shared with the Project whose Jobs are listed.
const globalSite = { ...siteTarget, ownerName: null };
const alicePc = { ...siteTarget, id: 'pc', name: 'Alice PC', ownerUserId: 'alice', ownerName: 'Alice' };

describe('手動投入を待つJob', () => {
  it('手動投入待ちのqueuedのJobだけをsiteごとに数える', () => {
    const jobs = [
      { ...waiting, id: 'a' },
      { ...waiting, id: 'b' },
      { ...waiting, id: 'c', status: 'claimed' as const, phase: 'submitting' as const },
      { ...queuedJob, id: 'd' },
      { ...waiting, id: 'e', targetId: 'removed-site' },
    ];
    expect(manualSubmissionGroups(jobs, [globalSite], { id: 'alice' })).toEqual([
      { targetId: 'site', targetName: 'Supercomputer', waitingJobs: 2, ownership: { kind: 'global' } },
      // A site that is no longer listed keeps its id so the command can still be run.
      {
        targetId: 'removed-site',
        targetName: 'removed-site',
        waitingJobs: 1,
        ownership: { kind: 'global' },
      },
    ]);
  });

  it('PCのJobは、所有者には自分の計算機、ほかのメンバーには所有者の計算機として分ける', () => {
    const jobs = [
      { ...waiting, id: 'a', targetId: alicePc.id },
      { ...waiting, id: 'b' },
    ];
    const ownership = (viewerId: string) =>
      manualSubmissionGroups(jobs, [alicePc, globalSite], { id: viewerId }).map((group) => [
        group.targetName,
        group.ownership,
      ]);
    expect(ownership('alice')).toEqual([
      ['Alice PC', { kind: 'own' }],
      ['Supercomputer', { kind: 'global' }],
    ]);
    // Another member sees whose computer it is; they still submit their own Jobs on it.
    expect(ownership('bob')).toEqual([
      ['Alice PC', { kind: 'someoneElse', ownerName: 'Alice' }],
      ['Supercomputer', { kind: 'global' }],
    ]);
  });

  it('所有者の名前が無ければ、所有者のIDで出す', () => {
    expect(manualSiteOwnership({ ownerUserId: 'carol', ownerName: null }, { id: 'bob' })).toEqual({
      kind: 'someoneElse',
      ownerName: 'carol',
    });
    expect(manualSiteOwnership(undefined, { id: 'bob' })).toEqual({ kind: 'global' });
  });

  it('投入を受け取った後のJobは手動投入待ちにしない', () => {
    expect(isWaitingManualSubmission(waiting)).toBe(true);
    expect(isWaitingManualSubmission({ status: 'claimed', phase: 'submitted' })).toBe(false);
    expect(isWaitingManualSubmission({ status: 'canceled', phase: 'waiting_manual' })).toBe(false);
  });

  it('本人がsiteのログインノードで実行するコマンドはsiteのIDを指定する', () => {
    expect(manualSubmitCommand(siteTarget.id)).toBe('mado-tracking submit --site site');
  });

  it('PCで待ち受けるときは--watchを、所有者が全員のJobを投入するときは--allを付ける', () => {
    expect(manualSubmitCommand('pc', { watch: true })).toBe('mado-tracking submit --site pc --watch');
    expect(manualSubmitCommand('pc', { all: true, watch: true })).toBe(
      'mado-tracking submit --site pc --watch --all',
    );
    expect(manualSubmitCommand('pc', { all: false, watch: false })).toBe(
      'mado-tracking submit --site pc',
    );
    expect(manualSubmitCommand('pc', OWNER_SUBMIT_OPTIONS)).toBe(
      'mado-tracking submit --site pc --watch --all',
    );
  });
});
