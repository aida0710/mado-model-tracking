import { z } from 'zod';
import { validateEarlyStoppingConfig } from './sweeps/hyperband.js';
import { validateSearchSpace } from './sweeps/searchSpace.js';
import type { EarlyStoppingConfig, SearchSpace } from './sweeps/types.js';
import { gpuIdsSchema, nameSchema, uuidSchema } from './validation.js';

// Bounds from the API contract: a sweep larger than this is better split, and more parallel
// trials than this would exceed any ComputeTarget's max_concurrent_jobs anyway.
export const MAX_SWEEP_TRIALS = 10000;
export const MAX_SWEEP_PARALLELISM = 100;
const DEFAULT_SWEEP_PARALLELISM = 1;
// The suggestion PRNG (mulberry32) keeps 32 bits of state.
export const MAX_SWEEP_SEED = 4294967295;
// Same bound as MLflow metric keys.
const MAX_OBJECTIVE_METRIC_LENGTH = 250;
// Same bound as Run parameter keys (jsonObjectSchema).
const MAX_PARAMETER_NAME_LENGTH = 200;
// A categorical string becomes a Run parameter value, which MLflow limits to 6000 characters.
const MAX_PARAMETER_STRING_LENGTH = 6000;
const DEFAULT_SWEEP_PAGE_LIMIT = 50;
const MAX_SWEEP_PAGE_LIMIT = 200;
const DEFAULT_TRIAL_PAGE_LIMIT = 100;
// One page covers a typical grid sweep without making a 10000-trial response.
const MAX_TRIAL_PAGE_LIMIT = 500;

const parameterValueSchema = z.union([
  z.string().max(MAX_PARAMETER_STRING_LENGTH),
  z.number(),
  z.boolean(),
]);

// Structure only; ranges, duplicates and grid limits are checked by validateSearchSpace so that
// its messages name the offending parameter.
const parameterDefinitionSchema = z.union([
  z.strictObject({ values: z.array(parameterValueSchema) }),
  z.strictObject({ value: parameterValueSchema }),
  z.strictObject({
    distribution: z.enum(['uniform', 'log_uniform', 'int_uniform', 'q_uniform']),
    min: z.number(),
    max: z.number(),
    q: z.number().optional(),
  }),
]);

const earlyStoppingSchema = z.strictObject({
  type: z.literal('hyperband'),
  minIter: z.number(),
  eta: z.number(),
  maxIter: z.number().optional(),
});

const sweepMethodSchema = z.enum(['grid', 'random', 'bayes']);
const maxTrialsSchema = z.number().int().min(1).max(MAX_SWEEP_TRIALS);
const parallelismSchema = z.number().int().min(1).max(MAX_SWEEP_PARALLELISM);

export const sweepCreateSchema = z.strictObject({
  name: nameSchema,
  taskId: uuidSchema,
  method: sweepMethodSchema,
  searchSpace: z.record(
    z.string().min(1).max(MAX_PARAMETER_NAME_LENGTH),
    parameterDefinitionSchema,
  ),
  objective: z.strictObject({
    metric: z.string().trim().min(1).max(MAX_OBJECTIVE_METRIC_LENGTH),
    goal: z.enum(['minimize', 'maximize']),
    aggregation: z.enum(['last', 'min', 'max']).default('last'),
  }),
  maxTrials: maxTrialsSchema,
  parallelism: parallelismSchema.default(DEFAULT_SWEEP_PARALLELISM),
  earlyStopping: earlyStoppingSchema.nullable().default(null),
  seed: z.number().int().min(0).max(MAX_SWEEP_SEED).optional(),
  targetId: uuidSchema.nullable().default(null),
  gpuIds: gpuIdsSchema.nullable().default(null),
});

export const sweepPatchSchema = z
  .strictObject({ maxTrials: maxTrialsSchema.optional(), parallelism: parallelismSchema.optional() })
  .refine((patch) => patch.maxTrials !== undefined || patch.parallelism !== undefined, {
    message: 'Specify maxTrials or parallelism',
  });

export const sweepCancelSchema = z.strictObject({
  cancelRunningTrials: z.boolean().default(false),
});

export const sweepListQuerySchema = z.strictObject({
  status: z.enum(['running', 'paused', 'finished', 'canceled', 'failed']).optional(),
  cursor: uuidSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SWEEP_PAGE_LIMIT)
    .default(DEFAULT_SWEEP_PAGE_LIMIT),
});

export const sweepTrialQuerySchema = z.strictObject({
  orderBy: z.enum(['trial_index', 'objective']).default('trial_index'),
  cursor: uuidSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_TRIAL_PAGE_LIMIT)
    .default(DEFAULT_TRIAL_PAGE_LIMIT),
});

export type SweepCreateInput = z.infer<typeof sweepCreateSchema>;
export type SweepPatchInput = z.infer<typeof sweepPatchSchema>;
export type SweepCancelInput = z.infer<typeof sweepCancelSchema>;
export type SweepListQuery = z.infer<typeof sweepListQuerySchema>;
export type SweepTrialQuery = z.infer<typeof sweepTrialQuerySchema>;

/** Semantic checks of the search definition (422 sweep_space_invalid / sweep_early_terminate_invalid). */
export function validateSweepDefinition(input: SweepCreateInput): void {
  validateSearchSpace(input.searchSpace as SearchSpace, input.method);
  if (input.earlyStopping) validateEarlyStoppingConfig(input.earlyStopping as EarlyStoppingConfig);
}
