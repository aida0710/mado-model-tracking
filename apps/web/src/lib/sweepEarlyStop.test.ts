import { describe, expect, it } from 'vitest';
import { isSweepEarlyStoppedRun } from './sweepEarlyStop';
import { SWEEP_EARLY_STOPPED_TAG } from './sweepRunTags';

describe('isSweepEarlyStoppedRun', () => {
  it('Sweepが打ち切ったRunは早期打ち切りとして扱う', () => {
    expect(isSweepEarlyStoppedRun({ status: 'canceled', tags: { [SWEEP_EARLY_STOPPED_TAG]: 'true' } })).toBe(true);
  });

  it('人が停止したRunは早期打ち切りにしない', () => {
    expect(isSweepEarlyStoppedRun({ status: 'canceled', tags: {} })).toBe(false);
  });
});
