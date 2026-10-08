import {
  DEFAULT_BASELINE_ALIAS,
  PROMOTION_CRITERIA_MAX,
  type Model,
  type ModelAutomationRule,
  type PromotionCriterion,
  type PromotionCriterionDirection,
  type PromotionCriterionMode,
  type PromotionMissingBaseline,
  type PromotionPolicyCreate,
} from '@mmt/contracts';
import { promotionTextTemplates } from '../i18n/promotion';
import { text } from '../i18n/catalog';

export const PROMOTION_DIRECTIONS: PromotionCriterionDirection[] = ['higher', 'lower'];
export const PROMOTION_MODES: PromotionCriterionMode[] = ['absolute', 'delta', 'relative_delta'];
export const PROMOTION_MISSING_BASELINE_CHOICES: PromotionMissingBaseline[] = ['pass', 'fail'];

/** One editable criterion row. threshold stays the typed text until the policy is saved. */
export interface PromotionCriterionDraft {
  // Stable React key; rows can be removed from the middle of the list.
  key: string;
  metric: string;
  direction: PromotionCriterionDirection;
  mode: PromotionCriterionMode;
  threshold: string;
}

export interface PromotionPolicyDraft {
  name: string;
  enabled: boolean;
  modelId: string;
  targetAlias: string;
  baselineAlias: string;
  evaluationRuleId: string;
  criteria: PromotionCriterionDraft[];
  missingBaseline: PromotionMissingBaseline;
  autoPromote: boolean;
}

let nextCriterionKey = 0;
export function createCriterionDraft(): PromotionCriterionDraft {
  nextCriterionKey += 1;
  return {
    key: `criterion-${nextCriterionKey}`,
    metric: '',
    direction: 'higher',
    mode: 'delta',
    threshold: '0',
  };
}

// The candidate usually replaces the baseline, so both aliases start at the comparison default.
export function createPromotionPolicyDraft(modelId: string): PromotionPolicyDraft {
  return {
    name: '',
    enabled: true,
    modelId,
    targetAlias: DEFAULT_BASELINE_ALIAS,
    baselineAlias: DEFAULT_BASELINE_ALIAS,
    evaluationRuleId: '',
    criteria: [createCriterionDraft()],
    missingBaseline: 'pass',
    autoPromote: false,
  };
}

/** Evaluation rules whose automatic Runs can judge versions of this Model. */
export function isEvaluationRuleEligible(rule: ModelAutomationRule, model: Model): boolean {
  return rule.kind === 'evaluation' && rule.enabled && rule.modelFamilies.includes(model.family);
}

/** Keeps the selected evaluation rule only while it can still evaluate the selected Model. */
export function updatePromotionPolicyDraft({
  next,
  models,
  rules,
}: {
  next: PromotionPolicyDraft;
  models: Model[];
  rules: ModelAutomationRule[];
}): PromotionPolicyDraft {
  const model = models.find((item) => item.id === next.modelId);
  const rule = rules.find((item) => item.id === next.evaluationRuleId);
  if (rule && (!model || !isEvaluationRuleEligible(rule, model)))
    return { ...next, evaluationRuleId: '' };
  return next;
}

/** A finite number with its sign kept; the sign decides improvement versus allowed regression. */
export function parseCriterionThreshold(value: string): number {
  const trimmed = value.trim();
  const threshold = Number(trimmed);
  if (!trimmed || !Number.isFinite(threshold))
    throw new Error(text.promotionCriterionThresholdInvalid);
  return threshold;
}

function buildCriterion(draft: PromotionCriterionDraft): PromotionCriterion {
  const metric = draft.metric.trim();
  if (!metric) throw new Error(text.promotionCriterionMetricRequired);
  return {
    metric,
    direction: draft.direction,
    mode: draft.mode,
    threshold: parseCriterionThreshold(draft.threshold),
  };
}

/** The criterion a row would save as, or null while the row is still incomplete or invalid. */
export function previewCriterion(draft: PromotionCriterionDraft): PromotionCriterion | null {
  try {
    return buildCriterion(draft);
  } catch {
    return null;
  }
}

export function buildPromotionPolicyInput({
  draft,
  models,
  rules,
}: {
  draft: PromotionPolicyDraft;
  models: Model[];
  rules: ModelAutomationRule[];
}): PromotionPolicyCreate {
  const name = draft.name.trim();
  const targetAlias = draft.targetAlias.trim();
  const baselineAlias = draft.baselineAlias.trim();
  if (!name) throw new Error(text.promotionPolicyNameRequired);
  const model = models.find((item) => item.id === draft.modelId);
  if (!model) throw new Error(text.promotionModelRequired);
  if (!targetAlias) throw new Error(text.promotionTargetAliasRequired);
  if (!baselineAlias) throw new Error(text.promotionBaselineAliasRequired);
  const rule = rules.find((item) => item.id === draft.evaluationRuleId);
  if (!rule || !isEvaluationRuleEligible(rule, model))
    throw new Error(text.promotionEvaluationRuleRequired);
  if (!draft.criteria.length) throw new Error(text.promotionCriteriaRequired);
  if (draft.criteria.length > PROMOTION_CRITERIA_MAX)
    throw new Error(promotionTextTemplates.criteriaTooMany(PROMOTION_CRITERIA_MAX));
  return {
    name,
    enabled: draft.enabled,
    modelId: model.id,
    targetAlias,
    baselineAlias,
    evaluationRuleId: rule.id,
    criteria: draft.criteria.map(buildCriterion),
    missingBaseline: draft.missingBaseline,
    autoPromote: draft.autoPromote,
  };
}

/**
 * What the threshold's sign means for a comparison with the baseline. A 'lower' metric such as
 * WER improves by going down, so -0.01 there requires improvement while +0.01 tolerates a rise.
 * Absolute criteria have no baseline, so they have no meaning here (null).
 */
export type CriterionThresholdMeaning =
  'improvement_required' | 'no_regression' | 'regression_allowed';

export function getCriterionThresholdMeaning(
  criterion: Pick<PromotionCriterion, 'direction' | 'mode' | 'threshold'>,
): CriterionThresholdMeaning | null {
  if (criterion.mode === 'absolute') return null;
  if (criterion.threshold === 0) return 'no_regression';
  const improves =
    criterion.direction === 'higher' ? criterion.threshold > 0 : criterion.threshold < 0;
  return improves ? 'improvement_required' : 'regression_allowed';
}

const PERCENT_FORMAT = new Intl.NumberFormat('ja-JP', {
  style: 'percent',
  maximumFractionDigits: 4,
  signDisplay: 'exceptZero',
});
const THRESHOLD_FORMAT = new Intl.NumberFormat('ja-JP', {
  maximumFractionDigits: 6,
  signDisplay: 'exceptZero',
});

/** relative_delta thresholds are ratios, shown as percentages. */
export function formatCriterionThreshold(
  criterion: Pick<PromotionCriterion, 'mode' | 'threshold'>,
): string {
  if (criterion.mode === 'relative_delta') return PERCENT_FORMAT.format(criterion.threshold);
  if (criterion.mode === 'absolute') return String(criterion.threshold);
  return THRESHOLD_FORMAT.format(criterion.threshold);
}

/** One-line summary such as "werの基準との差 ≤ -0.01". */
export function summarizeCriterion(criterion: PromotionCriterion): string {
  const comparator = criterion.direction === 'higher' ? '≥' : '≤';
  return `${promotionTextTemplates.criterionSubject(criterion.metric, criterion.mode)} ${comparator} ${formatCriterionThreshold(criterion)}`;
}
