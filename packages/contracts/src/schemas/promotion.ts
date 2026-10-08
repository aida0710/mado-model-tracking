import { z } from 'zod';
import type {
  PromotionCriterion,
  PromotionCriterionResult,
  PromotionEvaluation,
  PromotionEvaluationPage,
  PromotionPolicy,
} from '../promotion.js';
import { metricValueStatusSchema } from './evaluation.js';
import { cursorPageOf, idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

const promotionCriterionFields = {
  metric: z.string(),
  direction: z.enum(['higher', 'lower']),
  mode: z.enum(['absolute', 'delta', 'relative_delta']),
  threshold: z.number(),
};
export const promotionCriterionSchema = namedContractSchema(
  'PromotionCriterion',
  z.strictObject(promotionCriterionFields),
);
export const promotionPolicySchema = namedContractSchema(
  'PromotionPolicy',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    enabled: z.boolean(),
    modelId: idSchema,
    targetAlias: z.string(),
    baselineAlias: z.string(),
    evaluationRuleId: idSchema,
    criteria: z.array(promotionCriterionSchema),
    missingBaseline: z.enum(['pass', 'fail']),
    autoPromote: z.boolean(),
    createdBy: idSchema,
    createdAt: timestampSchema,
  }),
);
export const promotionCriterionResultSchema = namedContractSchema(
  'PromotionCriterionResult',
  z.strictObject({
    ...promotionCriterionFields,
    candidate: z.number().nullable(),
    baseline: z.number().nullable(),
    candidateStatus: metricValueStatusSchema,
    baselineStatus: metricValueStatusSchema,
    observed: z.number().nullable(),
    outcome: z.enum(['passed', 'failed', 'insufficient']),
    reason: z
      .enum([
        'candidate_metric_missing',
        'candidate_metric_not_finite',
        'baseline_metric_missing',
        'baseline_metric_not_finite',
        'baseline_zero',
        'baseline_missing',
        'baseline_not_evaluated',
      ])
      .nullable(),
  }),
);
export const promotionEvaluationSchema = namedContractSchema(
  'PromotionEvaluation',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    policyId: idSchema,
    modelId: idSchema,
    candidateVersionId: idSchema,
    candidateRunId: idSchema,
    baselineVersionId: idSchema.nullable(),
    baselineRunId: idSchema.nullable(),
    decision: z.enum(['passed', 'failed', 'insufficient', 'skipped']),
    criteriaResults: z.array(promotionCriterionResultSchema),
    reason: z
      .enum([
        'baseline_missing_first_promotion',
        'baseline_missing',
        'criteria_failed',
        'candidate_not_evaluated',
        'baseline_not_evaluated',
        'creator_access_revoked',
        'evaluation_error',
      ])
      .nullable(),
    promoted: z.boolean(),
    aliasEventId: idSchema.nullable(),
    sequence: z.number().int(),
    requestedBy: idSchema.nullable(),
    createdAt: timestampSchema,
  }),
);
export const promotionEvaluationPageSchema = namedContractSchema(
  'PromotionEvaluationPage',
  cursorPageOf(promotionEvaluationSchema),
);

type _PromotionCriterion = Expect<
  MutuallyAssignable<z.infer<typeof promotionCriterionSchema>, PromotionCriterion>
>;
type _PromotionPolicy = Expect<
  MutuallyAssignable<z.infer<typeof promotionPolicySchema>, PromotionPolicy>
>;
type _PromotionCriterionResult = Expect<
  MutuallyAssignable<z.infer<typeof promotionCriterionResultSchema>, PromotionCriterionResult>
>;
type _PromotionEvaluation = Expect<
  MutuallyAssignable<z.infer<typeof promotionEvaluationSchema>, PromotionEvaluation>
>;
type _PromotionEvaluationPage = Expect<
  MutuallyAssignable<z.infer<typeof promotionEvaluationPageSchema>, PromotionEvaluationPage>
>;
