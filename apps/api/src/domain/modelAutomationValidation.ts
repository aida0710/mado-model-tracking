import { z } from 'zod';
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
  kind: z.enum(['inference', 'evaluation']),
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
export type ModelAutomationRuleCreate = z.infer<typeof modelAutomationRuleSchema>;
