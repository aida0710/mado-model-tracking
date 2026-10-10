import { z } from 'zod';
import {
  CHILD_JOB_WAIT_MAX_SECONDS,
  DEFAULT_HOOK_MAX_STARTS_PER_HOUR,
  HOOK_CHECKPOINT_MODES,
  HOOK_CONCURRENCY_MODES,
  HOOK_FILTER_FIELDS,
  HOOK_TRIGGERS,
  HOOK_WEBHOOK_SIGNATURES,
  MAX_HOOK_CHECKPOINT_EVERY,
  MAX_HOOK_MAX_STARTS_PER_HOUR,
  MAX_JOB_ARRAY_SIZE,
  type HookFilter,
} from '@mmt/contracts';
import { DomainError } from './errors.js';
import {
  gpuCountSchema,
  gpuIdsSchema,
  jsonObjectSchema,
  maxAttemptsSchema,
  modelFamiliesSchema,
  nameSchema,
  runKindSchema,
  tagsSchema,
  uniqueIdsSchema,
  uuidSchema,
  walltimeSecondsSchema,
} from './validation.js';

// Executions shown per page; the history is kept, so the list pages backwards.
const DEFAULT_EXECUTION_PAGE_SIZE = 50;
const MAX_EXECUTION_PAGE_SIZE = 200;
const DEFAULT_CHILD_WAIT_SECONDS = 30;
// Chosen by the caller (a driver's loop counter, a CI build ID); bounded like other keys.
const idempotencyKeySchema = z.string().min(1).max(200);
const arraySizeSchema = z.number().int().min(1).max(MAX_JOB_ARRAY_SIZE);
const runStatusesSchema = z
  .array(z.enum(['finished', 'failed', 'canceled']))
  .min(1)
  .max(3)
  .refine((values) => new Set(values).size === values.length);

export const hookFilterSchema = z.strictObject({
  modelFamilies: modelFamiliesSchema.optional(),
  experimentIds: uniqueIdsSchema.min(1).optional(),
  runKinds: z
    .array(runKindSchema)
    .min(1)
    .max(runKindSchema.options.length)
    .refine((values) => new Set(values).size === values.length)
    .optional(),
  runStatuses: runStatusesSchema.optional(),
  tags: tagsSchema.optional(),
});

export const hookJobTemplateSchema = z.strictObject({
  experimentId: uuidSchema,
  kind: runKindSchema,
  codeVersionId: uuidSchema,
  modelVersionId: uuidSchema.nullable().default(null),
  inheritModelVersion: z.boolean().default(false),
  inputDatasetVersionIds: uniqueIdsSchema.default([]),
  inheritOutputDatasets: z.boolean().default(false),
  parameters: jsonObjectSchema.default({}),
  tags: tagsSchema.default({}),
  targetId: uuidSchema,
  gpuIds: gpuIdsSchema.default([]),
  gpuCount: gpuCountSchema.default(0),
  walltimeSeconds: walltimeSecondsSchema.nullable().default(null),
  arraySize: arraySizeSchema.nullable().default(null),
  datasetPartitionVersionId: uuidSchema.nullable().default(null),
  maxAttempts: maxAttemptsSchema,
  retryOnFailure: z.boolean().default(false),
  retryOnTimeout: z.boolean().default(false),
  allowChildJobs: z.boolean().default(false),
});

export const hookCreateSchema = z.strictObject({
  name: nameSchema,
  trigger: z.enum(HOOK_TRIGGERS),
  filter: hookFilterSchema.default({}),
  template: hookJobTemplateSchema,
  checkpointMode: z.enum(HOOK_CHECKPOINT_MODES).default('every'),
  checkpointEvery: z.number().int().min(1).max(MAX_HOOK_CHECKPOINT_EVERY).nullable().default(null),
  concurrency: z.enum(HOOK_CONCURRENCY_MODES).default('queue'),
  maxStartsPerHour: z
    .number()
    .int()
    .min(1)
    .max(MAX_HOOK_MAX_STARTS_PER_HOUR)
    .default(DEFAULT_HOOK_MAX_STARTS_PER_HOUR),
  webhookSignature: z.enum(HOOK_WEBHOOK_SIGNATURES).optional(),
});
export const hookToggleSchema = z.strictObject({ enabled: z.boolean() });
export const hookOwnerSchema = z.strictObject({ serviceAccountId: uuidSchema });
export const hookTriggerRequestSchema = z.strictObject({
  payload: jsonObjectSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export const hookExecutionQuerySchema = z.strictObject({
  hookId: uuidSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_EXECUTION_PAGE_SIZE)
    .default(DEFAULT_EXECUTION_PAGE_SIZE),
  cursor: uuidSchema.optional(),
});

export const childJobCreateSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  experimentId: uuidSchema.optional(),
  name: nameSchema,
  kind: runKindSchema,
  codeVersionId: uuidSchema,
  modelVersionId: uuidSchema.nullable().default(null),
  inputDatasetVersionIds: uniqueIdsSchema.default([]),
  parameters: jsonObjectSchema.default({}),
  tags: tagsSchema.default({}),
  targetId: uuidSchema,
  gpuIds: gpuIdsSchema.default([]),
  gpuCount: gpuCountSchema.default(0),
  walltimeSeconds: walltimeSecondsSchema.nullable().default(null),
  arraySize: arraySizeSchema.nullable().default(null),
  datasetPartitionVersionId: uuidSchema.nullable().default(null),
  maxAttempts: maxAttemptsSchema,
  retryOnFailure: z.boolean().default(false),
  retryOnTimeout: z.boolean().default(false),
  allowChildJobs: z.boolean().default(false),
});
export const childJobWaitQuerySchema = z.strictObject({
  timeoutSeconds: z.coerce
    .number()
    .int()
    .min(1)
    .max(CHILD_JOB_WAIT_MAX_SECONDS)
    .default(DEFAULT_CHILD_WAIT_SECONDS),
});

export type HookCreateInput = z.infer<typeof hookCreateSchema>;
export type HookJobTemplateInput = z.infer<typeof hookJobTemplateSchema>;
export type HookExecutionQuery = z.infer<typeof hookExecutionQuerySchema>;
export type ChildJobCreateInput = z.infer<typeof childJobCreateSchema>;

function invalidHook(message: string): never {
  throw new DomainError(422, message, 'invalid_request');
}

/** Settings that depend on each other; the schema checks each field alone. */
export function validateHookSettings(input: HookCreateInput): void {
  if ((input.trigger === 'webhook') !== (input.webhookSignature !== undefined))
    invalidHook('webhookSignatureはtriggerがwebhookのときだけ指定します');
  if ((input.checkpointMode === 'every_k') !== (input.checkpointEvery !== null))
    invalidHook('checkpointEveryはcheckpointModeがevery_kのときだけ指定します');
  if (input.trigger !== 'checkpoint_saved' && input.checkpointMode !== 'every')
    invalidHook('checkpointModeはtriggerがcheckpoint_savedのときだけ指定します');
  // The registered version is the input; a fixed one would silently be ignored.
  if (input.trigger === 'model_registered' && input.template.modelVersionId !== null)
    invalidHook('model_registeredのフックでは、登録された版を使うのでmodelVersionIdを指定しません');
  if (input.template.datasetPartitionVersionId && input.template.arraySize === null)
    invalidHook('datasetPartitionVersionIdはarraySizeと一緒に指定します');
  // A condition on a fact the trigger's event does not have would never match.
  const allowed = HOOK_FILTER_FIELDS[input.trigger];
  const unusable = (Object.keys(input.filter) as (keyof HookFilter)[]).filter(
    (field) => input.filter[field] !== undefined && !allowed.includes(field),
  );
  if (unusable.length)
    invalidHook(`trigger ${input.trigger}では絞り込みに${unusable.join('・')}を使えません`);
}
