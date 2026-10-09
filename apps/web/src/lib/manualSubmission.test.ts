import { describe, expect, it } from 'vitest';
import { queuedJob, siteTarget } from '../../tests/fixtures/execution';
import {
  isWaitingManualSubmission,
  manualSubmissionGroups,
  manualSubmitCommand,
} from './manualSubmission';

const waiting = { ...queuedJob, targetId: siteTarget.id, phase: 'waiting_manual' as const };

describe('手動投入を待つJob', () => {
  it('手動投入待ちのqueuedのJobだけをsiteごとに数える', () => {
    const jobs = [
      { ...waiting, id: 'a' },
      { ...waiting, id: 'b' },
      { ...waiting, id: 'c', status: 'claimed' as const, phase: 'submitting' as const },
      { ...queuedJob, id: 'd' },
      { ...waiting, id: 'e', targetId: 'removed-site' },
    ];
    expect(manualSubmissionGroups(jobs, [siteTarget])).toEqual([
      { targetId: 'site', targetName: 'Supercomputer', waitingJobs: 2 },
      // A site that is no longer listed keeps its id so the command can still be run.
      { targetId: 'removed-site', targetName: 'removed-site', waitingJobs: 1 },
    ]);
  });

  it('投入を受け取った後のJobは手動投入待ちにしない', () => {
    expect(isWaitingManualSubmission(waiting)).toBe(true);
    expect(isWaitingManualSubmission({ status: 'claimed', phase: 'submitted' })).toBe(false);
    expect(isWaitingManualSubmission({ status: 'canceled', phase: 'waiting_manual' })).toBe(false);
  });

  it('本人がsiteのログインノードで実行するコマンドはsiteのIDを指定する', () => {
    expect(manualSubmitCommand(siteTarget.id)).toBe('mado-tracking submit --site site');
  });
});
