import { describe, expect, it } from 'vitest';
import type { PromotionCriterionResult } from '@mmt/contracts';
import { describeCriterionResult } from '../src/domain/promotionReasonText.js';

function result(overrides: Partial<PromotionCriterionResult>): PromotionCriterionResult {
  return {
    metric: 'mae',
    direction: 'lower',
    mode: 'delta',
    threshold: 0,
    candidate: 1,
    baseline: 1,
    candidateStatus: 'present',
    baselineStatus: 'present',
    observed: 0,
    outcome: 'passed',
    reason: null,
    ...overrides,
  };
}

describe('alias履歴に残す昇格条件の説明', () => {
  it('差は引き算の誤差を丸めて6桁で書く', () => {
    expect(describeCriterionResult(result({ observed: -0.0003958333333333221 }))).toBe(
      'maeの基準との差=-0.000395833 ≤ 0',
    );
  });

  it('基準バージョンのない初回合格は、値の代わりに理由を日本語で書く', () => {
    expect(
      describeCriterionResult(result({ observed: null, baseline: null, reason: 'baseline_missing' })),
    ).toBe('maeの基準との差 ≤ 0: 値なし（基準バージョンなし）');
  });

  it('絶対値の条件は指標名と値だけを書く', () => {
    expect(
      describeCriterionResult(
        result({ metric: 'accuracy', mode: 'absolute', direction: 'higher', threshold: 0.8, observed: 0.9 }),
      ),
    ).toBe('accuracy=0.9 ≥ 0.8');
  });
});
