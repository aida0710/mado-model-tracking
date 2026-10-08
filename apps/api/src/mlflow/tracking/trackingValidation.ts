import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { uuidSchema } from '../../domain/validation.js';
import { serializeInt64 } from './trackingNumbers.js';

// These limits follow MLflow 3.17's entity and batch validators.
const MAX_KEY_LENGTH = 250;
const MAX_PARAMETER_VALUE_LENGTH = 6000;
const MAX_TAG_VALUE_LENGTH = 8000;
const MAX_BATCH_METRICS = 1000;
const MAX_BATCH_PARAMS = 100;
const MAX_BATCH_TAGS = 100;
const MAX_BATCH_ENTITIES = 1000;
const MAX_SEARCH_RESULTS = 50000;
const DEFAULT_SEARCH_RESULTS = 1000;
const MAX_EXPERIMENT_NAME_LENGTH = 500;
const MAX_EXPERIMENT_TAG_VALUE_LENGTH = 20000;
const MAX_DATASET_NAME_LENGTH = 500;
const MAX_DATASET_DIGEST_LENGTH = 36;
const MAX_DATASET_SOURCE_TYPE_LENGTH = 36;
const MAX_DATASET_SCHEMA_LENGTH = 1048575;
const MAX_DATASET_SOURCE_LENGTH = 65535;
const MAX_DATASET_PROFILE_LENGTH = 16777215;
const MAX_INPUT_TAG_KEY_LENGTH = 255;
const MAX_INPUT_TAG_VALUE_LENGTH = 500;
export const MAX_METRIC_HISTORY_RESULTS = 50000;
// PostgreSQL and JavaScript Date both retain the millisecond timestamps used by the SDK.
const MAX_TIMESTAMP = 8640000000000000;
// Metric and ModelOutput steps are signed int64 in the official service descriptor.
const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);

export function invalidParameter(message: string): never {
  throw new DomainError(400, message, 'invalid_parameter_value');
}
export function unsupported(message: string): never {
  throw new DomainError(422, message, 'not_implemented');
}

export const integerSchema = z
  .union([z.number(), z.string().regex(/^-?\d+$/)])
  .transform(Number)
  .pipe(z.number().int().safe());
export const timestampSchema = integerSchema.pipe(z.number().nonnegative().max(MAX_TIMESTAMP));
export const int64Schema = z
  .union([z.number().int().safe(), z.string().regex(/^-?\d+$/)])
  .refine((value) => {
    try {
      const integer = BigInt(value);
      return integer >= INT64_MIN && integer <= INT64_MAX;
    } catch {
      return false;
    }
  }, 'int64の範囲外です')
  .transform(serializeInt64);
export const experimentIdSchema = z.union([uuidSchema, z.literal('0')]);
// MLflow keys allow paths, spaces and Unicode, but paths cannot escape or normalize differently.
export const trackingKeySchema = z
  .string()
  .min(1)
  .max(MAX_KEY_LENGTH)
  .refine(
    (key) =>
      /^[\p{L}\p{N}_ .\-/]+$/u.test(key) &&
      !key.startsWith('/') &&
      key.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'keyの形式が不正です',
  );
export const tagSchema = z.strictObject({
  key: trackingKeySchema,
  value: z.string().max(MAX_TAG_VALUE_LENGTH),
});
export const experimentTagSchema = tagSchema.extend({
  value: z.string().max(MAX_EXPERIMENT_TAG_VALUE_LENGTH),
});
export const inputTagSchema = z.strictObject({
  key: z.string().max(MAX_INPUT_TAG_KEY_LENGTH),
  value: z.string().max(MAX_INPUT_TAG_VALUE_LENGTH),
});
export const paramSchema = z.strictObject({
  key: trackingKeySchema,
  value: z.string().max(MAX_PARAMETER_VALUE_LENGTH),
});
export const runReferenceFields = {
  run_id: uuidSchema.optional(),
  run_uuid: uuidSchema.optional(),
};
export function withRunReference<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema
    .extend(runReferenceFields)
    .refine((input) => {
      const reference = input as { run_id?: string; run_uuid?: string };
      return !!(reference.run_id || reference.run_uuid);
    }, 'run_idが必要です')
    .refine((input) => {
      const reference = input as { run_id?: string; run_uuid?: string };
      return !reference.run_id || !reference.run_uuid || reference.run_id === reference.run_uuid;
    }, 'run_idとrun_uuidが一致しません');
}
export const runReferenceSchema = withRunReference(z.strictObject({}));
export function runId(input: { run_id?: string; run_uuid?: string }): string {
  return input.run_id ?? input.run_uuid!;
}
const metricValueSchema = z.union([z.number(), z.enum(['NaN', 'Infinity', '-Infinity'])]);
export const metricSchema = z.strictObject({
  key: trackingKeySchema,
  value: metricValueSchema,
  timestamp: timestampSchema,
  step: int64Schema.default(0),
  model_id: z.string().min(1).optional(),
  dataset_name: z.string().min(1).optional(),
  dataset_digest: z.string().min(1).optional(),
  run_id: uuidSchema.optional(),
});
export const createExperimentSchema = z.strictObject({
  name: z.string().min(1).max(MAX_EXPERIMENT_NAME_LENGTH),
  artifact_location: z.string().min(1).optional(),
  tags: z.array(experimentTagSchema).default([]),
});
export const experimentReferenceSchema = z.strictObject({ experiment_id: experimentIdSchema });
export const createRunSchema = z.strictObject({
  experiment_id: experimentIdSchema.default('0'),
  user_id: z.string().optional(),
  run_name: z.string().max(MAX_TAG_VALUE_LENGTH).optional(),
  start_time: timestampSchema.optional(),
  tags: z.array(tagSchema).default([]),
});
export const updateRunSchema = withRunReference(
  z.strictObject({
    status: z
      .union([
        z.enum(['RUNNING', 'SCHEDULED', 'FINISHED', 'FAILED', 'KILLED']),
        z.number().int().min(1).max(5),
      ])
      .transform((status) =>
        typeof status === 'number'
          ? (['RUNNING', 'SCHEDULED', 'FINISHED', 'FAILED', 'KILLED'] as const)[status - 1]!
          : status,
      )
      .optional(),
    end_time: timestampSchema.nullable().optional(),
    run_name: z.string().max(MAX_TAG_VALUE_LENGTH).optional(),
  }),
);
export const logBatchSchema = z
  .strictObject({
    run_id: uuidSchema,
    metrics: z.array(metricSchema).max(MAX_BATCH_METRICS).default([]),
    params: z.array(paramSchema).max(MAX_BATCH_PARAMS).default([]),
    tags: z.array(tagSchema).max(MAX_BATCH_TAGS).default([]),
  })
  .refine(
    (batch) => batch.metrics.length + batch.params.length + batch.tags.length <= MAX_BATCH_ENTITIES,
    'batchの項目数が上限を超えています',
  );
export const datasetSchema = z.strictObject({
  name: z.string().min(1).max(MAX_DATASET_NAME_LENGTH),
  digest: z.string().min(1).max(MAX_DATASET_DIGEST_LENGTH),
  source_type: z.string().min(1).max(MAX_DATASET_SOURCE_TYPE_LENGTH),
  source: z.string().max(MAX_DATASET_SOURCE_LENGTH),
  schema: z.string().max(MAX_DATASET_SCHEMA_LENGTH).optional(),
  profile: z.string().max(MAX_DATASET_PROFILE_LENGTH).optional(),
});
export const logInputsSchema = z.strictObject({
  run_id: uuidSchema,
  datasets: z
    .array(z.strictObject({ dataset: datasetSchema, tags: z.array(inputTagSchema).default([]) }))
    .max(MAX_BATCH_ENTITIES)
    .default([]),
  models: z.array(z.strictObject({ model_id: z.string().min(1) })).default([]),
});
export const logOutputsSchema = z.strictObject({
  run_id: uuidSchema,
  models: z
    .array(z.strictObject({ model_id: z.string().min(1), step: int64Schema.default(0) }))
    .default([]),
});
export const viewSchema = z
  .union([integerSchema, z.enum(['ACTIVE_ONLY', 'DELETED_ONLY', 'ALL'])])
  .transform((value) =>
    typeof value === 'number' ? value : { ACTIVE_ONLY: 1, DELETED_ONLY: 2, ALL: 3 }[value],
  )
  .pipe(z.number().min(1).max(3))
  .default(1);
export const searchSchema = z.strictObject({
  max_results: integerSchema
    .pipe(z.number().positive().max(MAX_SEARCH_RESULTS))
    .default(DEFAULT_SEARCH_RESULTS),
  page_token: z.string().optional(),
  filter: z.string().default(''),
  order_by: z.array(z.string()).default([]),
});
export const searchExperimentsSchema = searchSchema.extend({ view_type: viewSchema });
export const searchRunsSchema = searchSchema.extend({
  experiment_ids: z.array(experimentIdSchema).default([]),
  run_view_type: viewSchema,
});
