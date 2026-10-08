import { describe, expect, it } from 'vitest';
import type { SweepTrial, SweepTrialCounts } from '@mmt/contracts';
import { isSweepActive, isSweepEnded, objectiveProgress, sortTrials, trialParameterNames } from './sweepTrials';

function trial(trialIndex: number, state: SweepTrial['state'], objectiveValue: number | null, parameters = {}): SweepTrial {
  return {
    id: `trial-${trialIndex}`, sweepId: 'sweep', trialIndex, parameters, runId: `run-${trialIndex}`, jobId: `job-${trialIndex}`,
    state, objectiveValue, objectiveStep: null, stopReason: null, runStatus: 'finished', jobStatus: 'finished',
    jobCancelRequested: false, createdAt: '2026-10-08T00:00:00Z', endedAt: null,
  };
}
const counts = (change: Partial<SweepTrialCounts>): SweepTrialCounts => ({
  queued: 0, running: 0, finished: 0, failed: 0, canceled: 0, early_stopped: 0, total: 0, ...change,
});

describe('Sweepの試行から画面の値を導く', () => {
  it('それまでの最良はfinishedとearly_stoppedだけで更新し、failedの値は点だけ描く', () => {
    const trials = [trial(2, 'finished', 0.3), trial(0, 'failed', 0.1), trial(1, 'finished', 0.5), trial(3, 'early_stopped', 0.2), trial(4, 'running', null)];
    expect(objectiveProgress(trials, 'minimize')).toEqual([
      { trialIndex: 0, objective: 0.1, bestSoFar: null },
      { trialIndex: 1, objective: 0.5, bestSoFar: 0.5 },
      { trialIndex: 2, objective: 0.3, bestSoFar: 0.3 },
      { trialIndex: 3, objective: 0.2, bestSoFar: 0.2 },
    ]);
    expect(objectiveProgress(trials, 'maximize').map((point) => point.bestSoFar)).toEqual([null, 0.5, 0.5, 0.5]);
  });

  it('目的値順はgoalの良い順で、目的値の無い試行は最後に試行番号順で並ぶ', () => {
    const trials = [trial(0, 'running', null), trial(1, 'finished', 0.4), trial(2, 'finished', 0.1), trial(3, 'queued', null)];
    expect(sortTrials(trials, 'objective', 'minimize').map((item) => item.trialIndex)).toEqual([2, 1, 0, 3]);
    expect(sortTrials(trials, 'objective', 'maximize').map((item) => item.trialIndex)).toEqual([1, 2, 0, 3]);
    expect(sortTrials(trials, 'trial_index', 'minimize').map((item) => item.trialIndex)).toEqual([0, 1, 2, 3]);
  });

  it('試行のparameter名を全試行から重複なく名前順に集める', () => {
    expect(trialParameterNames([trial(0, 'finished', 1, { lr: 1, batch: 2 }), trial(1, 'finished', 1, { lr: 2, dropout: 0 })]))
      .toEqual(['batch', 'dropout', 'lr']);
  });

  it('pausedでも実行中の試行が残る間はポーリングを続け、終わったSweepは操作できない', () => {
    expect(isSweepActive({ status: 'running', trialCounts: counts({}) })).toBe(true);
    expect(isSweepActive({ status: 'paused', trialCounts: counts({ running: 1 }) })).toBe(true);
    expect(isSweepActive({ status: 'paused', trialCounts: counts({ finished: 2 }) })).toBe(false);
    expect(isSweepActive({ status: 'finished', trialCounts: counts({ finished: 4 }) })).toBe(false);
    expect(['running', 'paused', 'finished', 'canceled', 'failed'].map((status) => isSweepEnded({ status: status as never })))
      .toEqual([false, false, true, true, true]);
  });
});
