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
  baselineAlias?: string;
  evaluationRuleId: string;
  criteria: PromotionCriterion[];
  missingBaseline?: PromotionMissingBaseline;
  autoPromote?: boolean;
}

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
  candidateVersionId: string;
  candidateRunId: string;
  baselineVersionId: string | null;
  baselineRunId: string | null;
  decision: PromotionDecision;
  criteriaResults: PromotionCriterionResult[];
  reason: string | null;
  promoted: boolean;
  aliasEventId: string | null;
  sequence: number;
  // null when the evaluation Run's completion triggered it; the user for a re-evaluation.
  requestedBy: string | null;
  createdAt: string;
}

export interface PromotionEvaluationPage {
  items: PromotionEvaluation[];
  nextCursor: string | null;
}
