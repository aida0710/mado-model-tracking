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

// Matches the CHECK in migration 034; a summary wider than this no longer fits one table row.
export const MAX_SUMMARY_METRICS = 20;
// The model version page asks for executions in pages; the default keeps the former fixed size.
export const DEFAULT_AUTOMATION_EXECUTION_LIMIT = 100;
// Automatic retries spend GPU time, so a rule retries only when maxAttempts is given explicitly.
export const DEFAULT_AUTOMATION_MAX_ATTEMPTS = 1;
export const MAX_AUTOMATION_EXECUTION_LIMIT = 200;

const summaryMetricsSchema = z
  .array(nameSchema)
  .max(MAX_SUMMARY_METRICS)
  .refine((metrics) => new Set(metrics).size === metrics.length, 'metrics must be unique');

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
  maxAttempts: maxAttemptsSchema.removeDefault().default(DEFAULT_AUTOMATION_MAX_ATTEMPTS),
  summaryMetrics: summaryMetricsSchema.default([]),
});

export const modelAutomationToggleSchema = z.strictObject({
  enabled: z.boolean(),
});

export const automationRuleOwnerSchema = z.strictObject({
  serviceAccountId: uuidSchema,
});

export const automationExecutionCreateSchema = z.union([
  z.strictObject({ modelVersionId: uuidSchema }),
  z.strictObject({ triggerRunId: uuidSchema }),
]);

export const automationExecutionQuerySchema = z.strictObject({
  modelVersionId: uuidSchema.optional(),
  ruleId: uuidSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_AUTOMATION_EXECUTION_LIMIT)
    .default(DEFAULT_AUTOMATION_EXECUTION_LIMIT),
  // Pending rows have md5-derived ids that are not RFC 4122 versions, so any GUID is accepted.
  cursor: z.guid().optional(),
});

export type ModelAutomationRuleCreate = z.infer<typeof modelAutomationRuleSchema>;
export type AutomationExecutionCreate = z.infer<typeof automationExecutionCreateSchema>;
export type AutomationExecutionQuery = z.infer<typeof automationExecutionQuerySchema>;

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
