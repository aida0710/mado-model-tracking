import { describe, expect, it } from 'vitest';
import { SWEEP_EARLY_STOPPED_TAG, isEarlyStoppedSweepTrial } from './runStatusDisplay';

describe('isEarlyStoppedSweepTrial', () => {
  it('Sweepが早期打ち切りしたRunだけを、中止ではなく早期打ち切りとして扱う', () => {
    expect(isEarlyStoppedSweepTrial({ status: 'canceled', tags: { [SWEEP_EARLY_STOPPED_TAG]: 'true' } })).toBe(true);
    expect(isEarlyStoppedSweepTrial({ status: 'canceled', tags: {} })).toBe(false);
    expect(isEarlyStoppedSweepTrial({ status: 'finished', tags: { [SWEEP_EARLY_STOPPED_TAG]: 'true' } })).toBe(false);
  });
});
