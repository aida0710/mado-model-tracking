import { z } from 'zod';
import type {
  EvaluationComparison,
  EvaluationComparisonStatus,
  MetricComparison,
  MetricValueSource,
  MetricValueStatus,
} from '../evaluation.js';
import { idSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const evaluationComparisonStatusSchema = z.enum([
  'ok',
  'baseline_missing',
  'baseline_not_evaluated',
  'candidate_not_evaluated',
]);
export const metricValueSourceSchema = z.enum(['dataset_context', 'run_latest']);
export const metricValueStatusSchema = z.enum(['present', 'missing', 'not_finite']);
export const metricComparisonSchema = namedContractSchema(
  'MetricComparison',
  z.strictObject({
    key: z.string(),
    candidate: z.number().nullable(),
    baseline: z.number().nullable(),
    candidateStatus: metricValueStatusSchema,
    baselineStatus: metricValueStatusSchema,
    delta: z.number().nullable(),
    relativeDelta: z.number().nullable(),
    source: z.strictObject({
      candidate: metricValueSourceSchema.nullable(),
      baseline: metricValueSourceSchema.nullable(),
    }),
  }),
);
export const evaluationComparisonSchema = namedContractSchema(
  'EvaluationComparison',
  z.strictObject({
    status: evaluationComparisonStatusSchema,
    modelId: idSchema,
    candidateVersionId: idSchema,
    baselineAlias: z.string().nullable(),
    baselineVersionId: idSchema.nullable(),
    candidateRunId: idSchema.nullable(),
    baselineRunId: idSchema.nullable(),
    referenceDatasetVersionIds: z.array(idSchema),
    codeVersionId: idSchema.nullable(),
    evaluationRuleId: idSchema.nullable(),
    metrics: z.array(metricComparisonSchema),
  }),
);

type _EvaluationComparisonStatus = Expect<
  MutuallyAssignable<z.infer<typeof evaluationComparisonStatusSchema>, EvaluationComparisonStatus>
>;
type _MetricValueSource = Expect<
  MutuallyAssignable<z.infer<typeof metricValueSourceSchema>, MetricValueSource>
>;
type _MetricValueStatus = Expect<
  MutuallyAssignable<z.infer<typeof metricValueStatusSchema>, MetricValueStatus>
>;
type _MetricComparison = Expect<
  MutuallyAssignable<z.infer<typeof metricComparisonSchema>, MetricComparison>
>;
type _EvaluationComparison = Expect<
  MutuallyAssignable<z.infer<typeof evaluationComparisonSchema>, EvaluationComparison>
>;
