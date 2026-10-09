import { z } from 'zod';
import type {
  ChildJobCreated,
  ChildJobWait,
  Hook,
  HookCreated,
  HookExecution,
  HookExecutionPage,
  HookFilter,
  HookJobTemplate,
  JobStatusCounts,
} from '../index.js';
import {
  HOOK_CHECKPOINT_MODES,
  HOOK_CONCURRENCY_MODES,
  HOOK_SKIP_REASONS,
  HOOK_TRIGGERS,
  HOOK_WEBHOOK_SIGNATURES,
} from '../hooks.js';
import { jobSchema } from './execution.js';
import {
  cursorPageOf,
  idSchema,
  jobStatusSchema,
  jsonObjectSchema,
  runKindSchema,
  stringMapSchema,
  timestampSchema,
} from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const hookTriggerSchema = z.enum(HOOK_TRIGGERS);
export const hookCheckpointModeSchema = z.enum(HOOK_CHECKPOINT_MODES);
export const hookConcurrencySchema = z.enum(HOOK_CONCURRENCY_MODES);
export const hookWebhookSignatureSchema = z.enum(HOOK_WEBHOOK_SIGNATURES);
export const hookSkipReasonSchema = z.enum(HOOK_SKIP_REASONS);

export const hookFilterSchema = namedContractSchema(
  'HookFilter',
  z.strictObject({
    modelFamilies: z.array(z.string()).optional(),
    experimentIds: z.array(idSchema).optional(),
    runKinds: z.array(runKindSchema).optional(),
    runStatuses: z.array(z.enum(['finished', 'failed', 'canceled'])).optional(),
    tags: stringMapSchema.optional(),
  }),
);
export const hookJobTemplateSchema = namedContractSchema(
  'HookJobTemplate',
  z.strictObject({
    experimentId: idSchema,
    kind: runKindSchema,
    codeVersionId: idSchema,
    modelVersionId: idSchema.nullable(),
    inheritModelVersion: z.boolean(),
    inputDatasetVersionIds: z.array(idSchema),
    inheritOutputDatasets: z.boolean(),
    parameters: jsonObjectSchema,
    tags: stringMapSchema,
    targetId: idSchema,
    gpuIds: z.array(z.string()),
    gpuCount: z.number().int(),
    walltimeSeconds: z.number().int().nullable(),
    arraySize: z.number().int().nullable(),
    datasetPartitionVersionId: idSchema.nullable(),
    maxAttempts: z.number().int(),
    retryOnFailure: z.boolean(),
    retryOnTimeout: z.boolean(),
    allowChildJobs: z.boolean(),
  }),
);
export const hookSchema = namedContractSchema(
  'Hook',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    enabled: z.boolean(),
    trigger: hookTriggerSchema,
    filter: hookFilterSchema,
    template: hookJobTemplateSchema,
    checkpointMode: hookCheckpointModeSchema,
    checkpointEvery: z.number().int().nullable(),
    concurrency: hookConcurrencySchema,
    maxStartsPerHour: z.number().int(),
    webhookSignature: hookWebhookSignatureSchema.nullable(),
    createdBy: idSchema,
    runAsUserId: idSchema,
    runAsKind: z.enum(['human', 'service']).optional(),
    runAsName: z.string().optional(),
    createdByName: z.string().optional(),
    createdAt: timestampSchema,
  }),
);
export const hookCreatedSchema = namedContractSchema(
  'HookCreated',
  z.strictObject({
    hook: hookSchema,
    webhookSecret: z.string().nullable(),
    webhookPath: z.string().nullable(),
  }),
);
export const hookExecutionSchema = namedContractSchema(
  'HookExecution',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    hookId: idSchema,
    status: z.enum(['pending', 'queued', 'skipped', 'failed']),
    subjectKind: z.enum(['manual', 'model_version', 'run', 'array_group', 'checkpoint', 'webhook']),
    subjectId: z.string().nullable(),
    reason: hookSkipReasonSchema.nullable(),
    error: z.string().nullable(),
    jobId: idSchema.nullable(),
    arrayGroupId: idSchema.nullable(),
    runId: idSchema.nullable(),
    waitingRunId: idSchema.nullable(),
    checkpointId: idSchema.nullable(),
    requestedBy: idSchema.nullable(),
    jobStatus: jobStatusSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
);
export const hookExecutionPageSchema = namedContractSchema(
  'HookExecutionPage',
  cursorPageOf(hookExecutionSchema),
);
export const childJobCreatedSchema = namedContractSchema(
  'ChildJobCreated',
  z.strictObject({
    created: z.boolean(),
    arrayGroupId: idSchema.nullable(),
    jobs: z.array(jobSchema),
  }),
);
export const jobStatusCountsSchema = namedContractSchema(
  'JobStatusCounts',
  z.strictObject({
    queued: z.number().int(),
    claimed: z.number().int(),
    running: z.number().int(),
    finished: z.number().int(),
    failed: z.number().int(),
    canceled: z.number().int(),
    total: z.number().int(),
  }),
);
export const childJobWaitSchema = namedContractSchema(
  'ChildJobWait',
  z.strictObject({ done: z.boolean(), counts: jobStatusCountsSchema }),
);

type _HookFilter = Expect<MutuallyAssignable<z.infer<typeof hookFilterSchema>, HookFilter>>;
type _HookJobTemplate = Expect<
  MutuallyAssignable<z.infer<typeof hookJobTemplateSchema>, HookJobTemplate>
>;
type _Hook = Expect<MutuallyAssignable<z.infer<typeof hookSchema>, Hook>>;
type _HookCreated = Expect<MutuallyAssignable<z.infer<typeof hookCreatedSchema>, HookCreated>>;
type _HookExecution = Expect<MutuallyAssignable<z.infer<typeof hookExecutionSchema>, HookExecution>>;
type _HookExecutionPage = Expect<
  MutuallyAssignable<z.infer<typeof hookExecutionPageSchema>, HookExecutionPage>
>;
type _ChildJobCreated = Expect<
  MutuallyAssignable<z.infer<typeof childJobCreatedSchema>, ChildJobCreated>
>;
type _JobStatusCounts = Expect<
  MutuallyAssignable<z.infer<typeof jobStatusCountsSchema>, JobStatusCounts>
>;
type _ChildJobWait = Expect<MutuallyAssignable<z.infer<typeof childJobWaitSchema>, ChildJobWait>>;
