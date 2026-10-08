import type {
  EvaluationComparison,
  MetricComparison,
  PromotionCriterion,
  PromotionCriterionResult,
  PromotionDecision,
  PromotionEvaluationReason,
  PromotionMissingBaseline,
} from '@mmt/contracts';

export interface CriteriaJudgement {
  decision: Exclude<PromotionDecision, 'skipped'>;
  reason: PromotionEvaluationReason | null;
  criteriaResults: PromotionCriterionResult[];
}

type Outcome = Pick<PromotionCriterionResult, 'observed' | 'outcome' | 'reason'>;

const MISSING_METRIC: MetricComparison = {
  key: '',
  candidate: null,
  baseline: null,
  candidateStatus: 'missing',
  baselineStatus: 'missing',
  delta: null,
  relativeDelta: null,
  source: { candidate: null, baseline: null },
};

// delta is computed in floating point (0.85 - 0.8 = 0.04999999999999993), so a value this close to
// the threshold, relative to the magnitudes involved, counts as exactly on it.
const THRESHOLD_RELATIVE_TOLERANCE = 1e-12;

function meetsThreshold(criterion: PromotionCriterion, observed: number): boolean {
  const scale = Math.max(1, Math.abs(observed), Math.abs(criterion.threshold));
  if (Math.abs(observed - criterion.threshold) <= THRESHOLD_RELATIVE_TOLERANCE * scale) return true;
  return criterion.direction === 'higher'
    ? observed > criterion.threshold
    : observed < criterion.threshold;
}

function compared(criterion: PromotionCriterion, observed: number): Outcome {
  return { observed, outcome: meetsThreshold(criterion, observed) ? 'passed' : 'failed', reason: null };
}

function judgeAbsolute(criterion: PromotionCriterion, metric: MetricComparison): Outcome {
  if (metric.candidateStatus === 'missing')
    return { observed: null, outcome: 'failed', reason: 'candidate_metric_missing' };
  if (metric.candidateStatus === 'not_finite')
    return { observed: null, outcome: 'failed', reason: 'candidate_metric_not_finite' };
  return compared(criterion, metric.candidate!);
}

// delta and relative_delta need a baseline value; how a missing baseline counts depends on why.
function judgeAgainstBaseline(
  criterion: PromotionCriterion,
  judged: {
    metric: MetricComparison;
    status: EvaluationComparison['status'];
    missingBaseline: PromotionMissingBaseline;
  },
): Outcome {
  const { metric, status, missingBaseline } = judged;
  const candidate = judgeAbsolute(criterion, metric);
  if (candidate.reason) return candidate;
  if (status === 'baseline_missing')
    return {
      observed: null,
      outcome: missingBaseline === 'pass' ? 'passed' : 'failed',
      reason: 'baseline_missing',
    };
  if (status === 'baseline_not_evaluated')
    return { observed: null, outcome: 'insufficient', reason: 'baseline_not_evaluated' };
  if (metric.baselineStatus === 'missing')
    return { observed: null, outcome: 'failed', reason: 'baseline_metric_missing' };
  if (metric.baselineStatus === 'not_finite')
    return { observed: null, outcome: 'failed', reason: 'baseline_metric_not_finite' };
  if (criterion.mode === 'delta') return compared(criterion, metric.delta!);
  if (metric.relativeDelta === null)
    return { observed: null, outcome: 'failed', reason: 'baseline_zero' };
  return compared(criterion, metric.relativeDelta);
}

function overallDecision(
  results: readonly PromotionCriterionResult[],
  status: EvaluationComparison['status'],
): Pick<CriteriaJudgement, 'decision' | 'reason'> {
  const failed = results.filter((result) => result.outcome === 'failed');
  if (failed.length)
    return {
      decision: 'failed',
      reason: failed.some((result) => result.reason === 'baseline_missing')
        ? 'baseline_missing'
        : 'criteria_failed',
    };
  if (results.some((result) => result.outcome === 'insufficient'))
    return { decision: 'insufficient', reason: 'baseline_not_evaluated' };
  if (status === 'baseline_missing')
    return { decision: 'passed', reason: 'baseline_missing_first_promotion' };
  return { decision: 'passed', reason: null };
}

/**
 * Applies a policy's criteria to a baseline comparison. NaN, ±Infinity and missing metrics fail the
 * criterion with a reason instead of being skipped. Absolute criteria need no baseline and are
 * checked even for a first release; with no baseline version, baseline-relative criteria follow
 * missingBaseline ('pass' records baseline_missing_first_promotion, decisions.md).
 */
export function evaluateCriteria(
  comparison: Pick<EvaluationComparison, 'status' | 'metrics'>,
  criteria: readonly PromotionCriterion[],
  missingBaseline: PromotionMissingBaseline,
): CriteriaJudgement {
  if (comparison.status === 'candidate_not_evaluated')
    return { decision: 'insufficient', reason: 'candidate_not_evaluated', criteriaResults: [] };
  const metrics = new Map(comparison.metrics.map((metric) => [metric.key, metric]));
  const criteriaResults = criteria.map((criterion): PromotionCriterionResult => {
    const metric = metrics.get(criterion.metric) ?? { ...MISSING_METRIC, key: criterion.metric };
    const outcome =
      criterion.mode === 'absolute'
        ? judgeAbsolute(criterion, metric)
        : judgeAgainstBaseline(criterion, { metric, status: comparison.status, missingBaseline });
    return {
      ...criterion,
      candidate: metric.candidate,
      baseline: metric.baseline,
      candidateStatus: metric.candidateStatus,
      baselineStatus: metric.baselineStatus,
      ...outcome,
    };
  });
  return { ...overallDecision(criteriaResults, comparison.status), criteriaResults };
}
