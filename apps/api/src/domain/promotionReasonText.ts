import type {
  PromotionCriterionMode,
  PromotionCriterionReason,
  PromotionCriterionResult,
} from '@mmt/contracts';

// The alias history shows this text as stored, so it is written for people here, in the same
// words as the Web's promotion screens (promotionModeLabels and the criterion reasons).

// Enough digits to tell two evaluations apart without the float noise of a subtraction.
const SIGNIFICANT_DIGITS = 6;

const modeSuffixes: Record<PromotionCriterionMode, string> = {
  absolute: '',
  delta: 'の基準との差',
  relative_delta: 'の基準との相対差',
};

const missingValueReasons: Record<PromotionCriterionReason, string> = {
  candidate_metric_missing: '候補に値なし',
  candidate_metric_not_finite: '候補の値がNaN/∞',
  baseline_metric_missing: '基準に値なし',
  baseline_metric_not_finite: '基準の値がNaN/∞',
  baseline_zero: '基準が0',
  baseline_missing: '基準版なし',
  baseline_not_evaluated: '基準版の評価なし',
};

export function formatReasonNumber(value: number): string {
  return String(Number(value.toPrecision(SIGNIFICANT_DIGITS)));
}

/** One criterion as `metricの基準との差=-0.000395833 ≤ 0`, or `… ≤ 0: 値なし（基準版なし）`. */
export function describeCriterionResult(result: PromotionCriterionResult): string {
  const comparator = result.direction === 'higher' ? '≥' : '≤';
  const subject = `${result.metric}${modeSuffixes[result.mode]}`;
  const threshold = formatReasonNumber(result.threshold);
  if (result.observed === null) {
    const why = result.reason ? `（${missingValueReasons[result.reason]}）` : '';
    return `${subject} ${comparator} ${threshold}: 値なし${why}`;
  }
  return `${subject}=${formatReasonNumber(result.observed)} ${comparator} ${threshold}`;
}
