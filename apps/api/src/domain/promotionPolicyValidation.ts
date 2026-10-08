import { z } from 'zod';
import { DEFAULT_BASELINE_ALIAS, PROMOTION_CRITERIA_MAX } from '@mmt/contracts';
import { nameSchema, uuidSchema } from './validation.js';

const DEFAULT_PROMOTION_EVALUATION_LIMIT = 50;
// Bounds one page of decisions; the Web table pages through longer histories.
const MAX_PROMOTION_EVALUATION_LIMIT = 200;

const criterionSchema = z.strictObject({
  metric: nameSchema,
  direction: z.enum(['higher', 'lower']),
  mode: z.enum(['absolute', 'delta', 'relative_delta']),
  // NaN and ±Infinity are rejected: a threshold must be comparable to every finite value.
  threshold: z.number().finite(),
});

const criteriaSchema = z
  .array(criterionSchema)
  .min(1)
  .max(PROMOTION_CRITERIA_MAX)
  .refine(
    (criteria) =>
      new Set(criteria.map((item) => `${item.metric}\u0000${item.mode}\u0000${item.direction}`))
        .size === criteria.length,
    { message: '同じmetric・mode・directionの基準が重複しています' },
  );

export const promotionPolicyCreateSchema = z.strictObject({
  name: nameSchema,
  enabled: z.boolean().default(true),
  modelId: uuidSchema,
  targetAlias: nameSchema,
  baselineAlias: nameSchema.default(DEFAULT_BASELINE_ALIAS),
  evaluationRuleId: uuidSchema,
  criteria: criteriaSchema,
  missingBaseline: z.enum(['pass', 'fail']).default('pass'),
  autoPromote: z.boolean().default(false),
});

export const promotionPolicyPatchSchema = z.strictObject({
  enabled: z.boolean(),
});

export const promotionPolicyOwnerSchema = z.strictObject({
  serviceAccountId: uuidSchema,
});

export const promotionPolicyQuerySchema = z.strictObject({
  modelId: uuidSchema.optional(),
});

export const promotionEvaluationQuerySchema = z.strictObject({
  modelId: uuidSchema.optional(),
  policyId: uuidSchema.optional(),
  candidateVersionId: uuidSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PROMOTION_EVALUATION_LIMIT)
    .default(DEFAULT_PROMOTION_EVALUATION_LIMIT),
  cursor: uuidSchema.optional(),
});

export type PromotionPolicyInput = z.infer<typeof promotionPolicyCreateSchema>;
export type PromotionPolicyQuery = z.infer<typeof promotionPolicyQuerySchema>;
export type PromotionEvaluationQuery = z.infer<typeof promotionEvaluationQuerySchema>;
