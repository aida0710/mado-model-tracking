import { ANALYSIS_MAX_METRICS, ANALYSIS_MAX_PARAMS } from '@mmt/contracts';
import { z } from 'zod';
import { runSearchSchema } from '../routes/runSearchRoutes.js';
import { uuidSchema } from './validation.js';

// MLflow accepts metric keys up to 250 characters, longer than native metric names.
const MAX_METRIC_KEY_LENGTH = 250;
// MLflow param keys are bounded at 250 characters as well.
const MAX_PARAM_KEY_LENGTH = 250;

const uniqueKeys = (keyLength: number) =>
  z
    .array(z.string().min(1).max(keyLength))
    .refine((keys) => new Set(keys).size === keys.length, 'keys must be unique');

/**
 * runIds has no element limit here: more than ANALYSIS_MAX_RUNS is answered with the same
 * 422 too_many_runs as a search or sweep that matches too many. The JSON body limit bounds
 * parsing.
 */
const runSetSchema = z.union([
  z.strictObject({
    runIds: z
      .array(uuidSchema)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, 'runIds must be unique'),
  }),
  // The analysis reads every matching Run, so paging conditions do not apply.
  z.strictObject({ search: runSearchSchema.omit({ limit: true, cursor: true }) }),
  z.strictObject({ sweepId: uuidSchema }),
]);

const paramsSchema = uniqueKeys(MAX_PARAM_KEY_LENGTH).min(1).max(ANALYSIS_MAX_PARAMS).optional();

export const runAnalysisTableRequestSchema = z.strictObject({
  runSet: runSetSchema,
  params: paramsSchema,
  metrics: uniqueKeys(MAX_METRIC_KEY_LENGTH).min(1).max(ANALYSIS_MAX_METRICS),
});

export const parameterImportanceRequestSchema = z.strictObject({
  runSet: runSetSchema,
  targetMetric: z.string().min(1).max(MAX_METRIC_KEY_LENGTH).optional(),
  params: paramsSchema,
});

export type RunSetQuery = z.infer<typeof runSetSchema>;
export type RunAnalysisTableQuery = z.infer<typeof runAnalysisTableRequestSchema>;
export type ParameterImportanceQuery = z.infer<typeof parameterImportanceRequestSchema>;
