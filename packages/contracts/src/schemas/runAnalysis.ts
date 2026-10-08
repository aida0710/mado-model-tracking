import { z } from 'zod';
import type {
  ParameterImportanceEntry,
  ParameterImportanceResult,
  RunAnalysisMetric,
  RunAnalysisObjective,
  RunAnalysisParam,
  RunAnalysisParamKind,
  RunAnalysisRow,
  RunAnalysisTableResponse,
} from '../runAnalysis.js';
import { idSchema, jsonValueSchema, runStatusSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import { sweepObjectiveSchema } from './sweeps.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const runAnalysisParamKindSchema = z.enum(['numeric', 'categorical']);
export const runAnalysisRowSchema = namedContractSchema(
  'RunAnalysisRow',
  z.strictObject({
    runId: idSchema,
    name: z.string(),
    experimentId: idSchema,
    status: runStatusSchema,
    sweepTrialIndex: z.number().int().optional(),
    params: z.record(z.string(), jsonValueSchema),
    metrics: z.record(z.string(), z.number().nullable()),
    objective: z.number().nullable().optional(),
  }),
);
export const runAnalysisParamSchema = namedContractSchema(
  'RunAnalysisParam',
  z.strictObject({
    key: z.string(),
    kind: runAnalysisParamKindSchema,
    values: z.array(z.string()).optional(),
    coverage: z.number(),
  }),
);
export const runAnalysisMetricSchema = namedContractSchema(
  'RunAnalysisMetric',
  z.strictObject({
    key: z.string(),
    min: z.number().nullable(),
    max: z.number().nullable(),
  }),
);
export const runAnalysisObjectiveSchema = namedContractSchema(
  'RunAnalysisObjective',
  z.strictObject({
    ...sweepObjectiveSchema.shape,
    min: z.number().nullable(),
    max: z.number().nullable(),
  }),
);
export const runAnalysisTableResponseSchema = namedContractSchema(
  'RunAnalysisTableResponse',
  z.strictObject({
    runs: z.array(runAnalysisRowSchema),
    params: z.array(runAnalysisParamSchema),
    metrics: z.array(runAnalysisMetricSchema),
    objective: runAnalysisObjectiveSchema.optional(),
  }),
);
export const parameterImportanceEntrySchema = namedContractSchema(
  'ParameterImportanceEntry',
  z.strictObject({
    param: z.string(),
    kind: runAnalysisParamKindSchema,
    correlation: z.number().nullable(),
    importance: z.number().nullable(),
    permutationImportance: z.number().nullable(),
    coverage: z.number(),
  }),
);
export const parameterImportanceResultSchema = namedContractSchema(
  'ParameterImportanceResult',
  z.strictObject({
    targetMetric: z.string(),
    targetSource: z.enum(['latest_metric', 'sweep_objective']),
    runCount: z.number().int(),
    skippedRunCount: z.number().int(),
    entries: z.array(parameterImportanceEntrySchema),
    excluded: z.array(
      z.strictObject({ param: z.string(), reason: z.enum(['high_cardinality', 'no_values']) }),
    ),
    importanceUnavailableReason: z.enum(['too_few_runs']).nullable(),
    outOfBagR2: z.number().nullable(),
  }),
);

type _RunAnalysisParamKind = Expect<
  MutuallyAssignable<z.infer<typeof runAnalysisParamKindSchema>, RunAnalysisParamKind>
>;
type _RunAnalysisRow = Expect<
  MutuallyAssignable<z.infer<typeof runAnalysisRowSchema>, RunAnalysisRow>
>;
type _RunAnalysisParam = Expect<
  MutuallyAssignable<z.infer<typeof runAnalysisParamSchema>, RunAnalysisParam>
>;
type _RunAnalysisMetric = Expect<
  MutuallyAssignable<z.infer<typeof runAnalysisMetricSchema>, RunAnalysisMetric>
>;
type _RunAnalysisObjective = Expect<
  MutuallyAssignable<z.infer<typeof runAnalysisObjectiveSchema>, RunAnalysisObjective>
>;
type _RunAnalysisTableResponse = Expect<
  MutuallyAssignable<z.infer<typeof runAnalysisTableResponseSchema>, RunAnalysisTableResponse>
>;
type _ParameterImportanceEntry = Expect<
  MutuallyAssignable<z.infer<typeof parameterImportanceEntrySchema>, ParameterImportanceEntry>
>;
type _ParameterImportanceResult = Expect<
  MutuallyAssignable<z.infer<typeof parameterImportanceResultSchema>, ParameterImportanceResult>
>;
