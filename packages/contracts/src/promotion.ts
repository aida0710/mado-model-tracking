import type { MetricValueStatus } from './evaluation.js';

// Upper bound on criteria per policy; matches the model_promotion_policies CHECK.
export const PROMOTION_CRITERIA_MAX = 50;

export type PromotionCriterionDirection = 'higher' | 'lower';
export type PromotionCriterionMode = 'absolute' | 'delta' | 'relative_delta';

/**
 * One pass condition. The observed value depends on mode: absolute = the candidate's value,
 * delta = candidate − baseline, relative_delta = (candidate − baseline) ÷ |baseline|.
 * direction 'higher' passes when observed ≥ threshold, 'lower' when observed ≤ threshold.
 * The threshold itself passes in both directions.
 */
export interface PromotionCriterion {
  metric: string;
  direction: PromotionCriterionDirection;
  mode: PromotionCriterionMode;
  threshold: number;
}

/** What a policy decides when the baseline alias points at no version (the first release). */
export type PromotionMissingBaseline = 'pass' | 'fail';

/**
 * Judges evaluation Runs that the automation rule evaluationRuleId produced for modelId.
 * The reference set and evaluation CodeVersion are that rule's fixed inputs and code version.
 * Settings are immutable; only enabled and the owner (runAsUserId) can change. With autoPromote a
 * passed automatic decision moves targetAlias, but only while the baseline is still the version the
 * decision compared against.
 */
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
  autoPromote: boolean;
  createdBy: string;
  /**
   * The user the policy acts as: its current Project admin authority is checked at each judgement,
   * and it is the actor of automatic promotions. Starts as createdBy; a Project admin can move it
   * to an active Service Account of the Project with the admin role.
   */
  runAsUserId: string;
  createdAt: string;
}

/** Body of PUT /projects/:p/promotion-policies/:id/owner. */
export interface PromotionPolicyOwnerTransfer {
  serviceAccountId: string;
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
 * the policy's rule. skipped: the policy could not judge (its run-as user lost Project admin, or
 * the judgement raised an error).
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
 * candidate_not_evaluated, baseline_not_evaluated, creator_access_revoked (the run-as user is no
 * longer Project admin), evaluation_error. On a passed decision of an autoPromote policy that did
 * not promote: baseline_changed (the baseline or target alias moved after the judgement read it)
 * or promotion_denied (the alias change was refused, e.g. by an alias protection).
 * null for an ordinary pass.
 */
export type PromotionEvaluationReason =
  | 'baseline_missing_first_promotion'
  | 'baseline_missing'
  | 'criteria_failed'
  | 'candidate_not_evaluated'
  | 'baseline_not_evaluated'
  | 'creator_access_revoked'
  | 'evaluation_error'
  | 'baseline_changed'
  | 'promotion_denied';

/** Reason recorded on a passed evaluation that had no baseline because the alias was unset. */
export const PROMOTION_FIRST_RELEASE_REASON: PromotionEvaluationReason = 'baseline_missing_first_promotion';

/** One append-only decision. A re-evaluation of the same candidate Run has sequence + 1. */
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
  /** Whether this decision moved targetAlias (automatic promotion). aliasEventId is that change. */
  promoted: boolean;
  aliasEventId: string | null;
  sequence: number;
  /** null for the automatic decision made when the evaluation Run finished. */
  requestedBy: string | null;
  createdAt: string;
}

/** One keyset page of decisions, newest first. nextCursor is the id to pass as `cursor` next. */
export interface PromotionEvaluationPage {
  items: PromotionEvaluation[];
  nextCursor: string | null;
}
