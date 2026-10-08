import type { MetricValueStatus } from './evaluation.js';

// Upper bound on criteria per policy; matches the model_promotion_policies CHECK.
export const PROMOTION_CRITERIA_MAX = 50;

/**
 * One pass condition. The observed value depends on mode: absolute = the candidate's value,
 * delta = candidate − baseline, relative_delta = (candidate − baseline) ÷ |baseline|.
 * direction 'higher' passes when observed ≥ threshold, 'lower' when observed ≤ threshold.
 * The threshold itself passes in both directions.
 */
export interface PromotionCriterion {
  metric: string;
  direction: 'higher' | 'lower';
  mode: 'absolute' | 'delta' | 'relative_delta';
  threshold: number;
}

/** What a policy decides when the baseline alias points at no version (the first release). */
export type PromotionMissingBaseline = 'pass' | 'fail';

/**
 * Judges evaluation Runs that the automation rule evaluationRuleId produced for modelId.
 * The reference set and evaluation CodeVersion are that rule's fixed inputs and code version.
 * Settings are immutable; only enabled can change. autoPromote is stored but not acted on yet.
 */
// Promotion policies decide whether a candidate ModelVersion beats the baseline alias, using only
// evaluation Runs that the policy's evaluation rule created (promotion-policy-gate owns the API).

export type PromotionCriterionDirection = 'higher' | 'lower';

/**
 * Which value is compared with the threshold:
 * absolute = candidate, delta = candidate − baseline, relative_delta = delta ÷ |baseline|.
 * A criterion passes when the value is ≥ threshold (direction 'higher') or ≤ threshold ('lower').
 */
export type PromotionCriterionMode = 'absolute' | 'delta' | 'relative_delta';

export interface PromotionCriterion {
  metric: string;
  direction: PromotionCriterionDirection;
  mode: PromotionCriterionMode;
  threshold: number;
}

/** What to decide when the baseline alias is unset (the first release). Default 'pass'. */
export type PromotionMissingBaseline = 'pass' | 'fail';

export type PromotionDecision = 'passed' | 'failed' | 'insufficient' | 'skipped';

/** Reason recorded on a passed evaluation that had no baseline because the alias was unset. */
export const PROMOTION_FIRST_RELEASE_REASON = 'baseline_missing_first_promotion';

export const PROMOTION_CRITERIA_MAX = 50;

/** Settings are immutable like automation rules; only `enabled` can change. */
export interface PromotionPolicy {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  modelId: string;
  targetAlias: string;
  baselineAlias: string;
  evaluationRuleId: string;
  criteria: PromotionCriterion[];
  missingBaseline: PromotionMissingBaseline;
  // A kind=evaluation automation rule of the same Project. Its fixed input datasets and code
  // version are the evaluation conditions; the policy does not store them separately.
  evaluationRuleId: string;
  criteria: PromotionCriterion[];
  missingBaseline: PromotionMissingBaseline;
  // Stored only; switching the alias on a pass is enabled in a later wave.
  autoPromote: boolean;
  createdBy: string;
  createdAt: string;
}

export interface PromotionPolicyCreate {
  name: string;
  enabled?: boolean;
  modelId: string;
  targetAlias: string;
  /** Defaults to DEFAULT_BASELINE_ALIAS ('production'). */
  baselineAlias?: string;
  evaluationRuleId: string;
  criteria: PromotionCriterion[];
  missingBaseline?: PromotionMissingBaseline;
  autoPromote?: boolean;
}

export interface PromotionPolicyPatch {
  enabled: boolean;
}

/**
 * passed / failed: every criterion could be judged (or the first release rule applied).
 * insufficient: a needed evaluation is missing, e.g. the baseline version has no evaluation by
 * the policy's rule. skipped: the policy could not judge (its creator lost Project admin, or the
 * judgement raised an error).
 */
export type PromotionDecision = 'passed' | 'failed' | 'insufficient' | 'skipped';

export type PromotionCriterionOutcome = 'passed' | 'failed' | 'insufficient';

/**
 * Why a criterion did not simply compare: candidate_metric_missing, candidate_metric_not_finite,
 * baseline_metric_missing, baseline_metric_not_finite, baseline_zero (relative_delta against 0),
 * baseline_missing (no baseline version; outcome follows missingBaseline),
 * baseline_not_evaluated. null when the observed value was compared with the threshold.
 */
export type PromotionCriterionReason =
  | 'candidate_metric_missing'
  | 'candidate_metric_not_finite'
  | 'baseline_metric_missing'
  | 'baseline_metric_not_finite'
  | 'baseline_zero'
  | 'baseline_missing'
  | 'baseline_not_evaluated';

export interface PromotionCriterionResult extends PromotionCriterion {
  candidate: number | null;
  baseline: number | null;
  candidateStatus: MetricValueStatus;
  baselineStatus: MetricValueStatus;
  /** The value compared with threshold (see PromotionCriterion). null when it could not be computed. */
  observed: number | null;
  outcome: PromotionCriterionOutcome;
  reason: PromotionCriterionReason | null;
}

/**
 * Why the whole decision came out as it did: baseline_missing_first_promotion (passed because no
 * baseline version exists and missingBaseline='pass'), baseline_missing, criteria_failed,
 * candidate_not_evaluated, baseline_not_evaluated, creator_access_revoked, evaluation_error.
 * null for an ordinary pass.
 */
export type PromotionEvaluationReason =
  | 'baseline_missing_first_promotion'
  | 'baseline_missing'
  | 'criteria_failed'
  | 'candidate_not_evaluated'
  | 'baseline_not_evaluated'
  | 'creator_access_revoked'
  | 'evaluation_error';

/** One append-only decision. A re-evaluation of the same candidate Run has sequence + 1. */
export interface PromotionCriterionResult extends PromotionCriterion {
  candidate: number | null;
  baseline: number | null;
  // The value compared with the threshold for this mode; null when it could not be computed.
  value: number | null;
  passed: boolean;
  // Why the criterion failed without a comparison, e.g. a missing or NaN metric.
  reason: string | null;
}

/** Append-only. A re-evaluation adds a row with sequence + 1 for the same policy and Run. */
export interface PromotionEvaluation {
  id: string;
  projectId: string;
  policyId: string;
  modelId: string;
  candidateVersionId: string;
  candidateRunId: string;
  baselineVersionId: string | null;
  baselineRunId: string | null;
  decision: PromotionDecision;
  criteriaResults: PromotionCriterionResult[];
  reason: PromotionEvaluationReason | null;
  /** Whether this decision moved targetAlias. Always false until automatic promotion exists. */
  promoted: boolean;
  aliasEventId: string | null;
  sequence: number;
  /** null for the automatic decision made when the evaluation Run finished. */
  reason: string | null;
  promoted: boolean;
  aliasEventId: string | null;
  sequence: number;
  // null when the evaluation Run's completion triggered it; the user for a re-evaluation.
  requestedBy: string | null;
  createdAt: string;
}

/** One keyset page of decisions, newest first. nextCursor is the id to pass as `cursor` next. */
export interface PromotionEvaluationPage {
  items: PromotionEvaluation[];
  nextCursor: string | null;
}
