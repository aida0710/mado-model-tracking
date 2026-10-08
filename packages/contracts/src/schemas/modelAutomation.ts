import { z } from 'zod';
import type {
  ModelAutomationExecution,
  ModelAutomationExecutionPage,
  ModelAutomationRule,
} from '../modelAutomation.js';
import {
  cursorPageOf,
  idSchema,
  jobStatusSchema,
  jsonObjectSchema,
  runStatusSchema,
  stringMapSchema,
  timestampSchema,
} from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const modelAutomationRuleSchema = namedContractSchema(
  'ModelAutomationRule',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    enabled: z.boolean(),
    modelFamilies: z.array(z.string()),
    kind: z.enum(['inference', 'evaluation', 'processing']),
    trigger: z.enum(['model_registered', 'upstream_run_finished']),
    upstreamRuleId: idSchema.nullable(),
    experimentId: idSchema,
    codeVersionId: idSchema,
    targetId: idSchema,
    gpuIds: z.array(z.string()),
    inputDatasetVersionIds: z.array(idSchema),
    parameters: jsonObjectSchema,
    tags: stringMapSchema,
    maxAttempts: z.number().int(),
    summaryMetrics: z.array(z.string()),
    createdBy: idSchema,
    runAsUserId: idSchema,
    runAsKind: z.enum(['human', 'service']).optional(),
    runAsName: z.string().optional(),
    createdAt: timestampSchema,
  }),
);
export const modelAutomationExecutionSchema = namedContractSchema(
  'ModelAutomationExecution',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    ruleId: idSchema,
    modelVersionId: idSchema,
    runId: idSchema.nullable(),
    jobId: idSchema.nullable(),
    status: z.enum(['pending', 'queued', 'failed', 'skipped']),
    sourceRunId: idSchema.nullable(),
    runStatus: runStatusSchema.nullable(),
    jobStatus: jobStatusSchema.nullable(),
    runStartedAt: timestampSchema.nullable().optional(),
    runEndedAt: timestampSchema.nullable().optional(),
    error: z.string().nullable(),
    triggerRunId: idSchema.nullable(),
    pipelineRootExecutionId: idSchema.nullable(),
    attempt: z.number().int(),
    source: z.enum(['automatic', 'manual']),
    requestedBy: idSchema.nullable(),
    retryOfExecutionId: idSchema.nullable(),
    createdAt: timestampSchema,
  }),
);
export const modelAutomationExecutionPageSchema = namedContractSchema(
  'ModelAutomationExecutionPage',
  cursorPageOf(modelAutomationExecutionSchema),
);

type _ModelAutomationRule = Expect<
  MutuallyAssignable<z.infer<typeof modelAutomationRuleSchema>, ModelAutomationRule>
>;
type _ModelAutomationExecution = Expect<
  MutuallyAssignable<z.infer<typeof modelAutomationExecutionSchema>, ModelAutomationExecution>
>;
type _ModelAutomationExecutionPage = Expect<
  MutuallyAssignable<
    z.infer<typeof modelAutomationExecutionPageSchema>,
    ModelAutomationExecutionPage
  >
>;
