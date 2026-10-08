import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import {
  buildRunSegments,
  decideRunResume,
  isResumeTransition,
  storedResumeReason,
} from './runResume.js';

const ended = {
  status: 'failed',
  lifecycleStage: 'active',
  startedAt: '2026-10-08T00:00:00.000Z',
} as const;

function refusalCode(operation: () => unknown): string | undefined {
  try {
    operation();
  } catch (error) {
    if (error instanceof DomainError) return `${error.status} ${error.code}`;
    throw error;
  }
  return undefined;
}

describe('Runの再開判定', () => {
  it('終端のJob無しRunは直前の状態を持って再開できる', () => {
    for (const status of ['finished', 'failed', 'canceled'] as const)
      expect(decideRunResume({ ...ended, status }, { hasJob: false })).toEqual({
        resume: true,
        previousStatus: status,
      });
  });

  it('runningのRunは何もしない', () => {
    expect(decideRunResume({ ...ended, status: 'running' }, { hasJob: false })).toEqual({
      resume: false,
    });
  });

  it('Job付きは409 run_finalized、queuedと開始前に取り消したRunは409 run_not_started、削除済みは409 run_deleted', () => {
    expect(refusalCode(() => decideRunResume(ended, { hasJob: true }))).toBe('409 run_finalized');
    expect(
      refusalCode(() =>
        decideRunResume({ ...ended, status: 'queued', startedAt: null }, { hasJob: false }),
      ),
    ).toBe('409 run_not_started');
    expect(
      refusalCode(() =>
        decideRunResume({ ...ended, status: 'canceled', startedAt: null }, { hasJob: false }),
      ),
    ).toBe('409 run_not_started');
    expect(
      refusalCode(() =>
        decideRunResume({ ...ended, lifecycleStage: 'deleted' }, { hasJob: false }),
      ),
    ).toBe('409 run_deleted');
  });

  it('終端から開始済みRunをrunningへ戻すときだけ再開として扱う', () => {
    expect(isResumeTransition(ended, 'running')).toBe(true);
    expect(isResumeTransition(ended, 'finished')).toBe(false);
    expect(isResumeTransition({ status: 'queued', startedAt: null }, 'running')).toBe(false);
    expect(isResumeTransition({ status: 'canceled', startedAt: null }, 'running')).toBe(false);
  });

  it('空白だけの理由は理由なしとして保存する', () => {
    expect(storedResumeReason('  ')).toBeNull();
    expect(storedResumeReason(undefined)).toBeNull();
    expect(storedResumeReason(' 学習の続き ')).toBe('学習の続き');
  });
});

describe('Runの区間', () => {
  it('再開イベントが無ければ最初の区間だけで、実行中なら終わりはnull', () => {
    expect(buildRunSegments({ status: 'running', startedAt: 't0', endedAt: null }, [])).toEqual([
      { startedAt: 't0', endedAt: null, endStatus: null, firstStep: null },
    ]);
  });

  it('二度再開すると3区間になり、各区間の終わりは次の再開時点の直前の終了で、firstStepは再開時の最大step+1', () => {
    const segments = buildRunSegments({ status: 'finished', startedAt: 't0', endedAt: 't5' }, [
      { resumedAt: 't2', previousStatus: 'failed', previousEndedAt: 't1', maxStepAtResume: 9 },
      { resumedAt: 't4', previousStatus: 'canceled', previousEndedAt: 't3', maxStepAtResume: null },
    ]);
    expect(segments).toEqual([
      { startedAt: 't0', endedAt: 't1', endStatus: 'failed', firstStep: null },
      { startedAt: 't2', endedAt: 't3', endStatus: 'canceled', firstStep: 10 },
      { startedAt: 't4', endedAt: 't5', endStatus: 'finished', firstStep: null },
    ]);
  });
});
