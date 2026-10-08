import { z } from 'zod';
import type { ModelAliasProtection, ModelAliasProtectionRole } from '@mmt/contracts';
import { satisfiesProjectRole } from './projectRoles.js';
import { uuidSchema } from './validation.js';

// Matches the model_alias_events.reason CHECK so the API rejects before the database does.
export const MAX_MODEL_ALIAS_REASON_LENGTH = 2000;
const DEFAULT_MODEL_ALIAS_EVENT_LIMIT = 50;
// Bounds one page of history; the Web table and SDK page through longer histories.
const MAX_MODEL_ALIAS_EVENT_LIMIT = 200;

const reasonSchema = z.string().max(MAX_MODEL_ALIAS_REASON_LENGTH);

export const modelAliasAssignmentSchema = z
  .strictObject({
    versionId: uuidSchema,
    reason: reasonSchema.optional(),
    evaluationId: uuidSchema.optional(),
    // The Python SDK (set_model_alias(evaluation_id=)) sends the evidence under the alias event's
    // field name; both names mean the same promotion decision.
    promotionEvaluationId: uuidSchema.optional(),
  })
  .refine(
    (body) =>
      !body.evaluationId ||
      !body.promotionEvaluationId ||
      body.evaluationId === body.promotionEvaluationId,
    { message: 'evaluationIdとpromotionEvaluationIdが異なります' },
  )
  .transform(({ promotionEvaluationId, ...body }) => ({
    ...body,
    evaluationId: body.evaluationId ?? promotionEvaluationId,
  }));

export const modelAliasRemovalSchema = z.strictObject({
  reason: reasonSchema.optional(),
});

export const modelAliasEventQuerySchema = z.strictObject({
  alias: z.string().min(1).max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_MODEL_ALIAS_EVENT_LIMIT)
    .default(DEFAULT_MODEL_ALIAS_EVENT_LIMIT),
  cursor: uuidSchema.optional(),
});

export const modelAliasProtectionInputSchema = z.strictObject({
  requiredRole: z.enum(['editor', 'admin']),
  requirePassedEvaluation: z.boolean().default(false),
});

export const modelAliasProtectionQuerySchema = z.strictObject({
  modelId: uuidSchema.optional(),
});

export type ModelAliasAssignment = z.infer<typeof modelAliasAssignmentSchema>;
export type ModelAliasProtectionInput = z.infer<typeof modelAliasProtectionInputSchema>;

/** What a manual change of one alias must satisfy once every matching protection is combined. */
export interface EffectiveAliasProtection {
  requiredRole: ModelAliasProtectionRole;
  requirePassedEvaluation: boolean;
}

/**
 * Combines the Project-wide and the Model protection of an alias into the stricter of each
 * setting, so a Model-level row can tighten but never loosen the Project-wide rule.
 * Returns null when the alias is not protected.
 */
export function combineAliasProtections(
  protections: readonly Pick<ModelAliasProtection, 'requiredRole' | 'requirePassedEvaluation'>[],
): EffectiveAliasProtection | null {
  if (!protections.length) return null;
  return protections.reduce<EffectiveAliasProtection>(
    (strictest, protection) => ({
      requiredRole: satisfiesProjectRole(strictest.requiredRole, protection.requiredRole)
        ? strictest.requiredRole
        : protection.requiredRole,
      requirePassedEvaluation:
        strictest.requirePassedEvaluation || protection.requirePassedEvaluation,
    }),
    { requiredRole: 'editor', requirePassedEvaluation: false },
  );
}
export type ModelAliasEventQuery = z.infer<typeof modelAliasEventQuerySchema>;
