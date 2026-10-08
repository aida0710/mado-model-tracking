import { describe, expect, it } from 'vitest';
import { compareTrialsByObjective, computeObjective, selectBestTrial } from './trialObjective.js';

describe('computeObjective', () => {
  const history = [
    { step: 0, value: 0.9 },
    { step: 2, value: 0.4 },
    { step: 1, value: 0.2 },
    { step: 3, value: 0.6 },
  ];

  it('既定の last は step が最大の点の値になる（記録順ではない）', () => {
    expect(computeObjective([...history].reverse())).toBe(0.6);
  });

  it('min と max は履歴全体の最小・最大になる', () => {
    expect(computeObjective(history, 'min')).toBe(0.2);
    expect(computeObjective(history, 'max')).toBe(0.9);
  });

  it('最後の値が NaN なら last は前の値で補完せず null になる', () => {
    expect(computeObjective([...history, { step: 4, value: Number.NaN }])).toBeNull();
  });

  it('min と max は NaN を除いて求め、有限の値が無ければ null になる', () => {
    expect(computeObjective([{ step: 0, value: Number.NaN }, { step: 1, value: 3 }], 'min')).toBe(3);
    expect(computeObjective([{ step: 0, value: Number.NaN }], 'max')).toBeNull();
    expect(computeObjective([], 'last')).toBeNull();
  });

  it('同じ step が2回あると後に記録した方を last にする', () => {
    expect(computeObjective([{ step: 1, value: 1 }, { step: 1, value: 2 }])).toBe(2);
  });
});

describe('最良試行の選択', () => {
  const trials = [
    { trialIndex: 3, objective: 0.5 },
    { trialIndex: 1, objective: null },
    { trialIndex: 2, objective: 0.1 },
    { trialIndex: 0, objective: 0.9 },
  ];

  it('minimize は最小、maximize は最大の試行を選び、objective が無い試行は選ばない', () => {
    expect(selectBestTrial(trials, 'minimize')?.trialIndex).toBe(2);
    expect(selectBestTrial(trials, 'maximize')?.trialIndex).toBe(0);
    expect(selectBestTrial([{ trialIndex: 0, objective: null }], 'minimize')).toBeNull();
  });

  it('同値は trialIndex の小さい方を選ぶ', () => {
    const tied = [
      { trialIndex: 5, objective: 0.1 },
      { trialIndex: 4, objective: 0.1 },
    ];
    expect(selectBestTrial(tied, 'minimize')?.trialIndex).toBe(4);
  });

  it('並べ替えでは良い順に並び、objective が無い試行は最後になる', () => {
    const sorted = [...trials].sort(compareTrialsByObjective('maximize')).map((trial) => trial.trialIndex);
    expect(sorted).toEqual([0, 3, 2, 1]);
  });
});
