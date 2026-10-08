import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors.js';
import { hyperbandRungs, shouldStop, validateEarlyStoppingConfig, type PeerProgress } from './hyperband.js';
import type { EarlyStoppingConfig, MetricPoint, SweepGoal } from './types.js';

const config: EarlyStoppingConfig = { type: 'hyperband', minIter: 1, eta: 3 };

/** step 0 から upToStep まで、毎 step 同じ値を記録した履歴 */
function flatHistory(value: number, upToStep: number): MetricPoint[] {
  return Array.from({ length: upToStep + 1 }, (_, step) => ({ step, value }));
}

function peersWith(values: number[], upToStep: number): PeerProgress[] {
  return values.map((value, index) => ({ trialIndex: index + 1, objectiveHistory: flatHistory(value, upToStep) }));
}

function decide(value: number, peerValues: number[], goal: SweepGoal, step = 1) {
  return shouldStop({
    trialIndex: 0,
    objectiveHistory: flatHistory(value, step),
    peers: peersWith(peerValues, step),
    goal,
    config,
  });
}

describe('hyperbandRungs', () => {
  it('eta=3・minIter=1 の rung は 1, 3, 9 と続く', () => {
    expect(hyperbandRungs(config, 26)).toEqual([1, 3, 9]);
  });

  it('maxIter を指定すると maxIter 未満の rung だけになる', () => {
    expect(hyperbandRungs({ ...config, maxIter: 9 }, 100)).toEqual([1, 3]);
  });
});

describe('shouldStop', () => {
  it('minimize で rung 到達試行の上位 1/eta に入らない試行を止める', () => {
    expect(decide(0.9, [0.1, 0.5], 'minimize')).toEqual({ stop: true, rung: 1, reason: 'below_rung_cutoff' });
    expect(decide(0.05, [0.1, 0.5], 'minimize')).toEqual({ stop: false, rung: 1, reason: 'within_rung_cutoff' });
  });

  it('maximize では値が大きい試行を残し、小さい試行を止める', () => {
    expect(decide(0.9, [0.1, 0.5], 'maximize').stop).toBe(false);
    expect(decide(0.1, [0.9, 0.5], 'maximize').stop).toBe(true);
  });

  it('rung に達した試行が eta 未満なら止めない', () => {
    expect(decide(0.9, [0.1], 'minimize')).toEqual({ stop: false, rung: 1, reason: 'not_enough_peers' });
  });

  it('まだ rung に達していない試行は比較相手に数えない', () => {
    const result = shouldStop({
      trialIndex: 0,
      objectiveHistory: flatHistory(0.9, 3),
      peers: [...peersWith([0.1], 3), { trialIndex: 9, objectiveHistory: flatHistory(0.01, 2) }],
      goal: 'minimize',
      config,
    });
    expect(result).toEqual({ stop: false, rung: 3, reason: 'not_enough_peers' });
  });

  it('最初の rung より前は止めない', () => {
    const result = shouldStop({
      trialIndex: 0,
      objectiveHistory: flatHistory(0.9, 0),
      peers: peersWith([0.1, 0.2, 0.3], 5),
      goal: 'minimize',
      config: { ...config, minIter: 2 },
    });
    expect(result).toEqual({ stop: false, reason: 'before_first_rung' });
  });

  it('rung の時点の値で比べる（rung より後の改善は使わない）', () => {
    // 試行0は step 3 で 0.9、step 4 で 0.01。到達した最高の rung は 3 なので 0.9 で比べる。
    const history = [...flatHistory(0.9, 3), { step: 4, value: 0.01 }];
    const result = shouldStop({ trialIndex: 0, objectiveHistory: history, peers: peersWith([0.1, 0.2], 4), goal: 'minimize', config });
    expect(result).toEqual({ stop: true, rung: 3, reason: 'below_rung_cutoff' });
  });

  it('9件の rung では上位3件を残し、4位以下を止める', () => {
    const peerValues = [0.1, 0.2, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9];
    expect(decide(0.25, peerValues, 'minimize', 9).stop).toBe(false);
    expect(decide(0.35, peerValues, 'minimize', 9)).toEqual({ stop: true, rung: 9, reason: 'below_rung_cutoff' });
  });

  it('rung の時点の値が NaN なら補完せず、止めない', () => {
    expect(decide(Number.NaN, [0.1, 0.5], 'minimize')).toEqual({ stop: false, rung: 1, reason: 'no_objective' });
  });

  it('peers に自分自身が含まれていても二重に数えない', () => {
    const result = shouldStop({
      trialIndex: 0,
      objectiveHistory: flatHistory(0.9, 1),
      peers: [{ trialIndex: 0, objectiveHistory: flatHistory(0.9, 1) }, ...peersWith([0.1], 1)],
      goal: 'minimize',
      config,
    });
    expect(result.reason).toBe('not_enough_peers');
  });
});

describe('validateEarlyStoppingConfig', () => {
  it.each<[EarlyStoppingConfig, string]>([
    [{ type: 'hyperband', minIter: 0, eta: 3 }, 'minIter'],
    [{ type: 'hyperband', minIter: 1, eta: 1 }, 'eta'],
    [{ type: 'hyperband', minIter: 3, eta: 3, maxIter: 3 }, 'maxIter'],
  ])('不正な設定を 422 で拒否する（%o）', (invalidConfig, field) => {
    expect(() => validateEarlyStoppingConfig(invalidConfig)).toThrow(DomainError);
    expect(() => validateEarlyStoppingConfig(invalidConfig)).toThrow(field);
  });
});
