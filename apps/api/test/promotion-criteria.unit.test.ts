import { describe, expect, it } from 'vitest';
import type { EvaluationComparison, MetricComparison, PromotionCriterion } from '@mmt/contracts';
import { compareMetrics } from '../src/domain/evaluationComparison.js';
import { evaluateCriteria } from '../src/domain/promotionCriteria.js';

function comparison(
  values: { candidate?: Record<string, number>; baseline?: Record<string, number> | null },
  status: EvaluationComparison['status'] = 'ok',
): Pick<EvaluationComparison, 'status' | 'metrics'> {
  const asMetrics = (metrics: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [key, { value, source: 'run_latest' as const }]),
    );
  const metrics: MetricComparison[] = compareMetrics({
    candidate: values.candidate ? asMetrics(values.candidate) : null,
    baseline: values.baseline ? asMetrics(values.baseline) : null,
  });
  return { status, metrics };
}

function criterion(overrides: Partial<PromotionCriterion>): PromotionCriterion {
  return { metric: 'accuracy', direction: 'higher', mode: 'absolute', threshold: 0.8, ...overrides };
}

function judge(
  values: Parameters<typeof comparison>[0],
  criteria: PromotionCriterion[],
  options: { status?: EvaluationComparison['status']; missingBaseline?: 'pass' | 'fail' } = {},
) {
  return evaluateCriteria(
    comparison(values, options.status),
    criteria,
    options.missingBaseline ?? 'pass',
  );
}

describe('昇格基準の判定', () => {
  it.each([
    ['higher', 'absolute', 0.8, { accuracy: 0.81 }, { accuracy: 0.5 }, 'passed', 0.81],
    ['higher', 'absolute', 0.8, { accuracy: 0.79 }, { accuracy: 0.5 }, 'failed', 0.79],
    ['lower', 'absolute', 0.2, { accuracy: 0.19 }, { accuracy: 0.5 }, 'passed', 0.19],
    ['lower', 'absolute', 0.2, { accuracy: 0.21 }, { accuracy: 0.5 }, 'failed', 0.21],
    ['higher', 'delta', 0.05, { accuracy: 0.9 }, { accuracy: 0.8 }, 'passed', 0.1],
    ['higher', 'delta', 0.05, { accuracy: 0.82 }, { accuracy: 0.8 }, 'failed', 0.02],
    ['lower', 'delta', -0.01, { accuracy: 0.1 }, { accuracy: 0.2 }, 'passed', -0.1],
    ['lower', 'delta', -0.01, { accuracy: 0.2 }, { accuracy: 0.2 }, 'failed', 0],
    ['higher', 'relative_delta', 0.1, { accuracy: 0.9 }, { accuracy: 0.8 }, 'passed', 0.125],
    ['higher', 'relative_delta', 0.1, { accuracy: 0.85 }, { accuracy: 0.8 }, 'failed', 0.0625],
    ['lower', 'relative_delta', -0.1, { accuracy: 0.1 }, { accuracy: 0.2 }, 'passed', -0.5],
    ['lower', 'relative_delta', -0.1, { accuracy: 0.19 }, { accuracy: 0.2 }, 'failed', -0.05],
  ] as const)(
    '%s・%sは閾値%sに対して候補%oと基準%oで%sになる',
    (direction, mode, threshold, candidate, baseline, outcome, observed) => {
      const result = judge({ candidate, baseline }, [criterion({ direction, mode, threshold })]);
      expect(result.decision).toBe(outcome);
      expect(result.reason).toBe(outcome === 'passed' ? null : 'criteria_failed');
      expect(result.criteriaResults[0]).toMatchObject({ outcome, reason: null });
      expect(result.criteriaResults[0]!.observed).toBeCloseTo(observed, 12);
    },
  );

  it.each([
    ['higher', 'absolute', 0.8, 0.8, 0.5],
    ['lower', 'absolute', 0.8, 0.8, 0.5],
    ['higher', 'delta', 0.05, 0.85, 0.8],
    ['lower', 'delta', 0.05, 0.85, 0.8],
    ['higher', 'relative_delta', 0.1, 0.33, 0.3],
    ['lower', 'relative_delta', -0.1, 0.27, 0.3],
  ] as const)('閾値ちょうどは%s・%sとも合格になる（浮動小数の誤差を含む）', (direction, mode, threshold, candidate, baseline) => {
    const result = judge({ candidate: { accuracy: candidate }, baseline: { accuracy: baseline } }, [
      criterion({ direction, mode, threshold }),
    ]);
    expect(result.decision).toBe('passed');
  });

  it('候補のNaN・欠損は理由付きでfailedになり、ほかの基準が合格でも全体はfailed', () => {
    const result = judge({ candidate: { accuracy: Number.NaN, wer: 0.1 }, baseline: { accuracy: 0.8, wer: 0.2 } }, [
      criterion({ metric: 'accuracy' }),
      criterion({ metric: 'wer', direction: 'lower', threshold: 0.2 }),
      criterion({ metric: 'f1' }),
    ]);
    expect(result.decision).toBe('failed');
    expect(result.reason).toBe('criteria_failed');
    expect(result.criteriaResults.map((item) => [item.metric, item.outcome, item.reason])).toEqual([
      ['accuracy', 'failed', 'candidate_metric_not_finite'],
      ['wer', 'passed', null],
      ['f1', 'failed', 'candidate_metric_missing'],
    ]);
  });

  it('基準のNaN・欠損・0はdelta系の基準をfailedにする', () => {
    const result = judge(
      { candidate: { a: 1, b: 1, c: 1 }, baseline: { a: Number.POSITIVE_INFINITY, c: 0 } },
      [
        criterion({ metric: 'a', mode: 'delta', threshold: 0 }),
        criterion({ metric: 'b', mode: 'delta', threshold: 0 }),
        criterion({ metric: 'c', mode: 'relative_delta', threshold: 0 }),
        criterion({ metric: 'c', mode: 'delta', threshold: 0 }),
      ],
    );
    expect(result.decision).toBe('failed');
    expect(result.criteriaResults.map((item) => item.reason)).toEqual([
      'baseline_metric_not_finite',
      'baseline_metric_missing',
      'baseline_zero',
      null,
    ]);
  });

  it('基準バージョンが無くmissing_baseline=passなら、delta系は合格扱いで初回昇格の理由を残す', () => {
    const result = judge(
      { candidate: { accuracy: 0.9 }, baseline: null },
      [criterion({ mode: 'delta', threshold: 0 }), criterion({ threshold: 0.8 })],
      { status: 'baseline_missing', missingBaseline: 'pass' },
    );
    expect(result.decision).toBe('passed');
    expect(result.reason).toBe('baseline_missing_first_promotion');
    expect(result.criteriaResults.map((item) => [item.outcome, item.reason])).toEqual([
      ['passed', 'baseline_missing'],
      ['passed', null],
    ]);
  });

  it('基準バージョンが無くても絶対値の基準は判定し、満たさなければfailedになる', () => {
    const result = judge({ candidate: { accuracy: 0.5 }, baseline: null }, [criterion({ threshold: 0.8 })], {
      status: 'baseline_missing',
      missingBaseline: 'pass',
    });
    expect(result.decision).toBe('failed');
    expect(result.reason).toBe('criteria_failed');
  });

  it('基準バージョンが無くmissing_baseline=failなら、delta系の基準でfailed(baseline_missing)になる', () => {
    const result = judge(
      { candidate: { accuracy: 0.9 }, baseline: null },
      [criterion({ mode: 'relative_delta', threshold: 0 })],
      { status: 'baseline_missing', missingBaseline: 'fail' },
    );
    expect(result).toMatchObject({ decision: 'failed', reason: 'baseline_missing' });
    expect(result.criteriaResults[0]).toMatchObject({ outcome: 'failed', reason: 'baseline_missing' });
  });

  it('基準バージョンに同じruleの評価が無ければdelta系はinsufficient、絶対値だけなら判定できる', () => {
    const relative = judge({ candidate: { accuracy: 0.9 }, baseline: null }, [criterion({ mode: 'delta', threshold: 0 })], {
      status: 'baseline_not_evaluated',
    });
    expect(relative).toMatchObject({ decision: 'insufficient', reason: 'baseline_not_evaluated' });
    const absolute = judge({ candidate: { accuracy: 0.9 }, baseline: null }, [criterion({ threshold: 0.8 })], {
      status: 'baseline_not_evaluated',
    });
    expect(absolute).toMatchObject({ decision: 'passed', reason: null });
  });

  it('候補の評価が見つからなければinsufficient(candidate_not_evaluated)になる', () => {
    expect(
      judge({ candidate: {}, baseline: null }, [criterion({})], { status: 'candidate_not_evaluated' }),
    ).toEqual({ decision: 'insufficient', reason: 'candidate_not_evaluated', criteriaResults: [] });
  });
});
