import { describe, expect, it } from 'vitest';
import type { JobStatus } from '@mmt/contracts';
import { isJobUnresponsive } from './jobLiveness';

describe('Jobの応答なし表示', () => {
  it('実行中でheartbeatが途絶したJobだけを応答なしにする', () => {
    expect(isJobUnresponsive({ status: 'running', heartbeatStale: true })).toBe(true);
    expect(isJobUnresponsive({ status: 'claimed', heartbeatStale: true })).toBe(true);
    expect(isJobUnresponsive({ status: 'running', heartbeatStale: false })).toBe(false);
  });

  it('待機中や終了済みのJobは途絶の印があっても応答なしにしない', () => {
    const inactive: JobStatus[] = ['queued', 'finished', 'failed', 'canceled'];
    for (const status of inactive)
      expect(isJobUnresponsive({ status, heartbeatStale: true })).toBe(false);
  });
});
