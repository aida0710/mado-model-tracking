import { z } from 'zod';
import { uuidSchema } from '../../domain/validation.js';
import { DomainError } from '../../domain/errors.js';
import {
  MAX_MODEL_NAME_LENGTH,
  MAX_MODEL_KEY_LENGTH,
  MAX_MODEL_VALUE_LENGTH,
  MAX_MODEL_KEY_VALUE_BATCH,
  MAX_MODEL_FILTER_LENGTH,
  MAX_MODEL_SEARCH_EXPERIMENTS,
  MAX_MODEL_SEARCH_DATASETS,
  MAX_MODEL_ORDER_FIELDS,
  MAX_MODEL_ORDER_FIELD_LENGTH,
  MAX_MODEL_PAGE_SIZE,
  DEFAULT_MODEL_PAGE_SIZE,
  MAX_MODEL_PAGE_TOKEN_LENGTH,
  MAX_MODEL_URI_LENGTH,
  MAX_MODEL_DESCRIPTION_LENGTH,
  MAX_MODEL_DATASET_DIGEST_LENGTH,
  MAX_MODEL_VERSION_DIGITS,
  READY_LOGGED_MODEL_STATUS,
  FAILED_LOGGED_MODEL_STATUS,
} from './limits.js';

// Native registry names have the same 200 character limit.
export const modelNameSchema = z.string().min(1).max(MAX_MODEL_NAME_LENGTH);
export const loggedModelIdSchema = z.string().regex(/^m-[a-f0-9]{32}$/);
// MLflow accepts tag/parameter keys with paths and dots; do not restrict them to identifiers.
export const keySchema = z.string().min(1).max(MAX_MODEL_KEY_LENGTH);
const keyValueSchema = z.strictObject({
  key: keySchema,
  value: z.string().max(MAX_MODEL_VALUE_LENGTH),
});
const keyValuesSchema = z.array(keyValueSchema).max(MAX_MODEL_KEY_VALUE_BATCH).default([]);
export const createLoggedModelSchema = z.strictObject({
  experiment_id: z.union([uuidSchema, z.literal('0')]),
  name: modelNameSchema.optional(),
  model_type: z.string().max(MAX_MODEL_NAME_LENGTH).optional(),
  source_run_id: uuidSchema.optional(),
  params: keyValuesSchema,
  tags: keyValuesSchema,
});
export const finalizeSchema = z.strictObject({
  model_id: loggedModelIdSchema.optional(),
  status: z.union([
    z.literal('LOGGED_MODEL_READY'),
    z.literal('LOGGED_MODEL_UPLOAD_FAILED'),
    z.literal(READY_LOGGED_MODEL_STATUS),
    z.literal(FAILED_LOGGED_MODEL_STATUS),
  ]),
});
export const loggedModelTagsSchema = z.strictObject({
  model_id: loggedModelIdSchema.optional(),
  tags: keyValuesSchema,
});
export const loggedModelParamsSchema = z.strictObject({
  model_id: loggedModelIdSchema.optional(),
  params: keyValuesSchema,
});
export const deleteLoggedModelSchema = z.strictObject({ model_id: loggedModelIdSchema.optional() });

const datasetSchema = z.strictObject({
  dataset_name: modelNameSchema,
  dataset_digest: z.string().min(1).max(MAX_MODEL_DATASET_DIGEST_LENGTH).optional(),
});
export const searchLoggedModelsSchema = z.strictObject({
  experiment_ids: z
    .array(z.union([uuidSchema, z.literal('0')]))
    .min(1)
    .max(MAX_MODEL_SEARCH_EXPERIMENTS),
  filter: z.string().max(MAX_MODEL_FILTER_LENGTH).default(''),
  datasets: z.array(datasetSchema).max(MAX_MODEL_SEARCH_DATASETS).default([]),
  max_results: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_MODEL_PAGE_SIZE)
    .default(DEFAULT_MODEL_PAGE_SIZE),
  order_by: z
    .array(
      z.strictObject({
        field_name: z.string().min(1).max(MAX_MODEL_ORDER_FIELD_LENGTH),
        ascending: z.boolean().default(true),
        dataset_name: modelNameSchema.optional(),
        dataset_digest: z.string().min(1).max(MAX_MODEL_DATASET_DIGEST_LENGTH).optional(),
      }),
    )
    .max(MAX_MODEL_ORDER_FIELDS)
    .default([]),
  page_token: z.string().max(MAX_MODEL_PAGE_TOKEN_LENGTH).optional(),
});
export const createRegisteredModelSchema = z.strictObject({
  name: modelNameSchema,
  tags: keyValuesSchema,
  description: z.string().max(MAX_MODEL_DESCRIPTION_LENGTH).default(''),
  deployment_job_id: z.string().optional(),
});
export const registeredModelReferenceSchema = z.strictObject({ name: modelNameSchema });
export const versionSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(MAX_MODEL_VERSION_DIGITS);
export const modelVersionReferenceSchema = z.strictObject({
  name: modelNameSchema,
  version: versionSchema,
});
export const createModelVersionSchema = z.strictObject({
  name: modelNameSchema,
  source: z.string().min(1).max(MAX_MODEL_URI_LENGTH),
  run_id: uuidSchema.optional(),
  tags: keyValuesSchema,
  description: z.string().max(MAX_MODEL_DESCRIPTION_LENGTH).default(''),
  run_link: z.string().max(MAX_MODEL_URI_LENGTH).default(''),
  model_id: loggedModelIdSchema.optional(),
});
export const aliasSchema = z
  .string()
  .min(1)
  .max(MAX_MODEL_NAME_LENGTH)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine((alias) => !/^v[0-9]+$/i.test(alias) && alias.toLowerCase() !== 'latest');
export const aliasReferenceSchema = z.strictObject({ name: modelNameSchema, alias: aliasSchema });
export const setAliasSchema = aliasReferenceSchema.extend({ version: versionSchema });
export const setModelTagSchema = registeredModelReferenceSchema.extend({
  key: keySchema,
  value: z.string().max(MAX_MODEL_VALUE_LENGTH),
});
export const deleteModelTagSchema = registeredModelReferenceSchema.extend({ key: keySchema });
export const setVersionTagSchema = modelVersionReferenceSchema.extend({
  key: keySchema,
  value: z.string().max(MAX_MODEL_VALUE_LENGTH),
});
export const deleteVersionTagSchema = modelVersionReferenceSchema.extend({ key: keySchema });
export const updateModelSchema = registeredModelReferenceSchema.extend({
  description: z.string().max(MAX_MODEL_DESCRIPTION_LENGTH).optional(),
  deployment_job_id: z.string().optional(),
});
export const renameModelSchema = registeredModelReferenceSchema.extend({
  new_name: modelNameSchema,
});
export const updateVersionSchema = modelVersionReferenceSchema.extend({
  description: z.string().max(MAX_MODEL_DESCRIPTION_LENGTH).optional(),
});
export const transitionStageSchema = modelVersionReferenceSchema.extend({
  stage: z.enum(['None', 'Staging', 'Production', 'Archived']),
  archive_existing_versions: z.boolean().default(false),
});
export const latestVersionsSchema = registeredModelReferenceSchema.extend({
  stages: z.array(z.enum(['None', 'Staging', 'Production', 'Archived'])).optional(),
});
export const searchRegistrySchema = z.strictObject({
  filter: z.string().max(MAX_MODEL_FILTER_LENGTH).default(''),
  max_results: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_MODEL_PAGE_SIZE)
    .default(DEFAULT_MODEL_PAGE_SIZE),
  order_by: z
    .array(z.string().max(MAX_MODEL_ORDER_FIELD_LENGTH))
    .max(MAX_MODEL_ORDER_FIELDS)
    .default([]),
  page_token: z.string().max(MAX_MODEL_PAGE_TOKEN_LENGTH).optional(),
});

export type CreateLoggedModel = z.infer<typeof createLoggedModelSchema>;
export type SearchLoggedModels = z.infer<typeof searchLoggedModelsSchema>;
export type CreateRegisteredModel = z.infer<typeof createRegisteredModelSchema>;
export type CreateModelVersion = z.infer<typeof createModelVersionSchema>;
export type SearchRegistry = z.infer<typeof searchRegistrySchema>;

export function keyValueMap(entries: { key: string; value: string }[]): Record<string, string> {
  const values = new Map<string, string>();
  for (const { key, value } of entries) {
    if (values.has(key) && values.get(key) !== value)
      invalidParameter('同じkeyに異なる値が指定されています');
    values.set(key, value);
  }
  return Object.fromEntries(values);
}

export function invalidParameter(message: string): never {
  throw new DomainError(422, message, 'invalid_parameter_value');
}

export function unsupported(message: string): never {
  throw new DomainError(422, message, 'not_implemented');
}
