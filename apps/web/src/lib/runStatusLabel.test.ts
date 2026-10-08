import { describe, expect, it } from 'vitest';
import { runStatusLabel } from './runStatusLabel';

describe('Runの状態の表示名', () => {
  it('Sweepが早期打ち切りにした試行は、中止ではなく早期打ち切りと出す', () => {
    expect(runStatusLabel({ status: 'canceled', tags: { 'mmt.sweepEarlyStopped': 'true' } })).toBe('早期打ち切り');
    expect(runStatusLabel({ status: 'canceled', tags: {} })).toBe('中止');
  });

  it('状態はSweep画面と同じ日本語で出す', () => {
    expect(runStatusLabel({ status: 'finished', tags: { 'mmt.sweepEarlyStopped': 'true' } })).toBe('完了');
    expect(runStatusLabel({ status: 'queued', tags: {} })).toBe('待機中');
  });
});
