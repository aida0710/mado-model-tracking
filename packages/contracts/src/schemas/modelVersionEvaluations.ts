import { z } from 'zod';
import type {
  AutomatedRunSummary,
  ModelVersionDetail,
  ModelVersionEvaluationSummary,
  RunDownstreamPage,
} from '../modelVersionEvaluations.js';
import {
  idSchema,
  jsonObjectSchema,
  runKindSchema,
  runStatusSchema,
  timestampSchema,
} from './primitives.js';
import { modelSchema, modelVersionSchema } from './registry.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const modelVersionDetailSchema = namedContractSchema(
  'ModelVersionDetail',
  z.strictObject({
    version: modelVersionSchema,
    model: modelSchema,
    aliases: z.array(z.string()),
  }),
);
export const automatedRunSummarySchema = namedContractSchema(
  'AutomatedRunSummary',
  z.strictObject({
    id: idSchema,
    name: z.string(),
    kind: runKindSchema,
    status: runStatusSchema,
    modelVersionId: idSchema.nullable(),
    codeVersionId: idSchema.nullable(),
    parentRunId: idSchema.nullable(),
    latestMetrics: z.record(z.string(), z.number()),
    parameters: jsonObjectSchema,
    referenceDatasetVersionIds: z.array(idSchema),
    upstreamDatasetVersionIds: z.array(idSchema),
    automatic: z.boolean(),
    ruleId: idSchema.nullable(),
    executionId: idSchema.nullable(),
    pipelineRootExecutionId: idSchema.nullable(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
  }),
);
export const modelVersionEvaluationSummarySchema = namedContractSchema(
  'ModelVersionEvaluationSummary',
  z.strictObject({
    modelVersionId: idSchema,
    items: z.array(automatedRunSummarySchema),
    nextCursor: z.string().nullable(),
  }),
);
export const runDownstreamPageSchema = namedContractSchema(
  'RunDownstreamPage',
  z.strictObject({
    runId: idSchema,
    items: z.array(automatedRunSummarySchema),
    nextCursor: z.string().nullable(),
  }),
);

type _ModelVersionDetail = Expect<
  MutuallyAssignable<z.infer<typeof modelVersionDetailSchema>, ModelVersionDetail>
>;
type _AutomatedRunSummary = Expect<
  MutuallyAssignable<z.infer<typeof automatedRunSummarySchema>, AutomatedRunSummary>
>;
type _ModelVersionEvaluationSummary = Expect<
  MutuallyAssignable<
    z.infer<typeof modelVersionEvaluationSummarySchema>,
    ModelVersionEvaluationSummary
  >
>;
type _RunDownstreamPage = Expect<
  MutuallyAssignable<z.infer<typeof runDownstreamPageSchema>, RunDownstreamPage>
>;
