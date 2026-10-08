import { z } from 'zod';
import { DomainError } from './errors.js';
import {
  gpuIdsSchema,
  jsonObjectSchema,
  maxAttemptsSchema,
  modelFamiliesSchema,
  nameSchema,
  tagsSchema,
  uniqueIdsSchema,
  uuidSchema,
} from './validation.js';

export const modelAutomationRuleSchema = z.strictObject({
  name: nameSchema,
  enabled: z.boolean().default(true),
  modelFamilies: modelFamiliesSchema,
  kind: z.enum(['inference', 'evaluation', 'processing']),
  trigger: z.enum(['model_registered', 'upstream_run_finished']).default('model_registered'),
  upstreamRuleId: uuidSchema.nullish().transform((id) => id ?? null),
  experimentId: uuidSchema,
  codeVersionId: uuidSchema,
  targetId: uuidSchema,
  gpuIds: gpuIdsSchema.default([]),
  inputDatasetVersionIds: uniqueIdsSchema.default([]),
  parameters: jsonObjectSchema.default({}),
  tags: tagsSchema.default({}),
  maxAttempts: maxAttemptsSchema,
});

export const modelAutomationToggleSchema = z.strictObject({
  enabled: z.boolean(),
});

export const automationExecutionCreateSchema = z.union([
  z.strictObject({ modelVersionId: uuidSchema }),
  z.strictObject({ triggerRunId: uuidSchema }),
]);

export type ModelAutomationRuleCreate = z.infer<typeof modelAutomationRuleSchema>;
export type AutomationExecutionCreate = z.infer<typeof automationExecutionCreateSchema>;

// A chained rule needs the rule it follows; a registration rule must not name one.
export function assertRuleTrigger(
  rule: Pick<ModelAutomationRuleCreate, 'trigger' | 'upstreamRuleId'>,
): void {
  if ((rule.trigger === 'upstream_run_finished') !== (rule.upstreamRuleId !== null))
    throw new DomainError(
      422,
      'upstreamRuleIdはtriggerがupstream_run_finishedのときだけ、必ず指定します',
      'invalid_automation_trigger',
    );
}
