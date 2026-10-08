import { z } from 'zod';
import type {
  ComparedDatasetVersion,
  ComparedModelVersion,
  RunComparison,
  RunComparisonNamespace,
  RunComparisonRow,
  RunComparisonValue,
} from '../runComparison.js';
import { metricSeriesSchema } from './metricSeries.js';
import { idSchema } from './primitives.js';
import { runSchema } from './runs.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const runComparisonNamespaceSchema = z.enum(['params', 'metrics', 'tags']);
export const runComparisonValueSchema = namedContractSchema(
  'RunComparisonValue',
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export const runComparisonRowSchema = namedContractSchema(
  'RunComparisonRow',
  z.strictObject({
    namespace: runComparisonNamespaceSchema,
    key: z.string(),
    values: z.array(runComparisonValueSchema),
    deltaFromBaseline: z.array(z.number().nullable()).optional(),
    relativeDeltaFromBaseline: z.array(z.number().nullable()).optional(),
  }),
);
export const comparedDatasetVersionSchema = namedContractSchema(
  'ComparedDatasetVersion',
  z.strictObject({
    id: idSchema,
    datasetId: idSchema,
    namespace: z.string(),
    name: z.string(),
    version: z.string(),
    digest: z.string(),
  }),
);
export const comparedModelVersionSchema = namedContractSchema(
  'ComparedModelVersion',
  z.strictObject({
    id: idSchema,
    modelId: idSchema,
    modelName: z.string(),
    version: z.string(),
  }),
);
export const runComparisonSchema = namedContractSchema(
  'RunComparison',
  z.strictObject({
    runs: z.array(runSchema),
    baselineRunId: idSchema.nullable(),
    datasetVersions: z.array(comparedDatasetVersionSchema),
    modelVersions: z.array(comparedModelVersionSchema),
    rows: z.array(runComparisonRowSchema),
    history: z.array(metricSeriesSchema).optional(),
  }),
);

type _RunComparisonNamespace = Expect<
  MutuallyAssignable<z.infer<typeof runComparisonNamespaceSchema>, RunComparisonNamespace>
>;
type _RunComparisonValue = Expect<
  MutuallyAssignable<z.infer<typeof runComparisonValueSchema>, RunComparisonValue>
>;
type _RunComparisonRow = Expect<
  MutuallyAssignable<z.infer<typeof runComparisonRowSchema>, RunComparisonRow>
>;
type _ComparedDatasetVersion = Expect<
  MutuallyAssignable<z.infer<typeof comparedDatasetVersionSchema>, ComparedDatasetVersion>
>;
type _ComparedModelVersion = Expect<
  MutuallyAssignable<z.infer<typeof comparedModelVersionSchema>, ComparedModelVersion>
>;
type _RunComparison = Expect<
  MutuallyAssignable<z.infer<typeof runComparisonSchema>, RunComparison>
>;
