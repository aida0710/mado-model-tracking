import { z } from 'zod';
import { executionRuntimeSchema, runtimeKindSchema } from './runtimeValidation.js';
import { codeSourceSchema } from './codeSourceValidation.js';
export { codeSourceSchema } from './codeSourceValidation.js';

export const uuidSchema = z.uuid();
export const nameSchema = z.string().trim().min(1).max(200);
export const jsonObjectSchema = z.record(z.string().max(200), z.json());
export const tagsSchema = z.record(z.string().min(1).max(200), z.string().max(4000));
export const runKindSchema = z.enum([
  'inference',
  'evaluation',
  'training',
  'finetuning',
  'processing',
]);
export const runStatusSchema = z.enum(['queued', 'running', 'finished', 'failed', 'canceled']);
export const roleSchema = z.enum(['viewer', 'editor', 'admin']);
export const roleAssignmentSchema = z.strictObject({ role: roleSchema });
// Same bounds as user_groups.group_name (migration 012); names come from Authentik as-is.
export const groupNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed');
// Query string of GET /users: a prefix of an email, username, or display name.
export const userSearchQuerySchema = z.object({ query: z.string().trim().min(1).max(200) });
export const artifactBackendSchema = z.enum(['filesystem', 's3']);
export const scopeSchema = z.enum([
  'read',
  'runs:write',
  'registry:write',
  'artifacts:write',
  'jobs:write',
  'worker:execute',
  'admin',
]);
export const uniqueIdsSchema = z
  .array(uuidSchema)
  .max(1000)
  .refine((values) => new Set(values).size === values.length, 'IDs must be unique');
// A rule or code version can explicitly name up to 100 compatible model families.
const MAX_MODEL_FAMILIES = 100;
export const modelFamiliesSchema = z
  .array(nameSchema)
  .min(1)
  .max(MAX_MODEL_FAMILIES)
  .refine((families) => new Set(families).size === families.length);

export function isRelativeFilePath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => !!part && part !== '.' && part !== '..')
  );
}
export const projectCreateSchema = z.strictObject({
  name: nameSchema,
  description: z.string().max(20000).default(''),
  artifactBackend: artifactBackendSchema.default('filesystem'),
});
export const projectPatchSchema = projectCreateSchema
  .pick({ description: true, artifactBackend: true })
  .partial();
export const namedEntitySchema = z.strictObject({
  name: nameSchema,
  description: z.string().max(20000).default(''),
});
export const modelCreateSchema = namedEntitySchema.extend({ family: nameSchema });
export const datasetCreateSchema = namedEntitySchema.extend({
  namespace: nameSchema.default('local'),
});
// Commands use argv rather than a shell; bound arguments before handing them to workers.
const commandArgumentSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => !value.includes('\0'));
const commandSchema = z.array(commandArgumentSchema).max(100);
export const executionModeSchema = z.enum(['run', 'test']);
export const codeVersionSchema = z
  .strictObject({
    version: nameSchema,
    source: codeSourceSchema.nullable().default(null),
    runtime: executionRuntimeSchema.default({ kind: 'python' }),
    entrypoint: commandSchema.min(1),
    testEntrypoint: commandSchema.default([]),
    requirements: z.array(z.string().min(1).max(2000)).max(1000).default([]),
    environment: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(10000))
      .default({}),
    supportedModelFamilies: modelFamiliesSchema,
    taskTypes: z
      .array(runKindSchema)
      .min(1)
      .max(5)
      .refine((values) => new Set(values).size === values.length),
  })
  .superRefine((code, context) => {
    if (code.runtime.kind === 'python' && code.source === null)
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Python requires a source',
      });
    if (code.runtime.kind !== 'python' && code.requirements.length)
      context.addIssue({
        code: 'custom',
        path: ['requirements'],
        message: 'Container requirements must be empty',
      });
  });
export const modelVersionSchema = z.strictObject({
  // Omitted versions are numbered by the API (registerModelVersion).
  version: nameSchema.optional(),
  parentModelVersionIds: uniqueIdsSchema.default([]),
  sourceRunId: uuidSchema.nullish(),
  weightsUri: z.string().min(1).max(4000).nullish(),
  artifactId: uuidSchema.nullish(),
  defaultCodeVersionId: uuidSchema.nullish(),
  metadata: jsonObjectSchema.default({}),
});
export const externalDatasetRefSchema = z.strictObject({
  pluginId: uuidSchema,
  externalId: nameSchema,
  namespace: nameSchema,
  name: nameSchema,
  version: nameSchema,
});
export const datasetVersionSchema = z.strictObject({
  version: nameSchema,
  uri: z.string().min(1).max(4000),
  digest: z.string().min(1).max(1000),
  schema: jsonObjectSchema.default({}),
  metadata: jsonObjectSchema.default({}),
  sourceRunId: uuidSchema.nullish(),
  parentDatasetVersionIds: uniqueIdsSchema.default([]),
  externalRef: externalDatasetRefSchema.nullish(),
});
export const runCreateSchema = z.strictObject({
  experimentId: uuidSchema,
  name: nameSchema,
  kind: runKindSchema,
  parameters: jsonObjectSchema.default({}),
  tags: tagsSchema.default({}),
  modelVersionId: uuidSchema.nullish(),
  codeVersionId: uuidSchema.nullish(),
  executionMode: executionModeSchema.optional(),
  inputDatasetVersionIds: uniqueIdsSchema.default([]),
  parentRunId: uuidSchema.nullish(),
  environment: jsonObjectSchema.default({}),
});
export const runPatchSchema = z.strictObject({
  name: nameSchema.optional(),
  parameters: jsonObjectSchema.optional(),
  tags: tagsSchema.optional(),
  status: runStatusSchema.optional(),
  environment: jsonObjectSchema.optional(),
});
export const metricSchema = z.strictObject({
  name: nameSchema,
  value: z.number(),
  step: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  timestamp: z.iso.datetime({ offset: true }),
});
export const logSchema = z.strictObject({
  timestamp: z.iso.datetime({ offset: true }),
  level: z.enum(['info', 'warning', 'error']),
  message: z.string().max(200000),
});
// Batches are bounded to keep write transactions short while supporting SDK uploads.
export const metricBatchSchema = z.strictObject({
  metrics: z.array(metricSchema).min(1).max(1000),
});
export const logBatchSchema = z.strictObject({
  entries: z.array(logSchema).min(1).max(1000),
});
export const gpuIdsSchema = z
  .array(z.string().min(1).max(100))
  .max(128)
  .refine((values) => new Set(values).size === values.length);
// Explicit retries remain bounded, and the default matches the existing worker policy.
const MAX_JOB_ATTEMPTS = 100;
const DEFAULT_JOB_ATTEMPTS = 3;
export const maxAttemptsSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_JOB_ATTEMPTS)
  .default(DEFAULT_JOB_ATTEMPTS);
export const targetSchema = z.strictObject({
  name: nameSchema,
  host: z
    .string()
    .min(1)
    .max(253)
    .refine((value) => !value.startsWith('-') && !/[\s\0]/.test(value)),
  port: z.number().int().min(1).max(65535),
  username: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*$/),
  sshKeyPath: z.string().max(4000),
  knownHostsPath: z.string().max(4000),
  workDirectory: z.string().min(1).max(4000),
  pythonExecutable: z.string().min(1).max(4000),
  runtimeKinds: z
    .array(runtimeKindSchema)
    .min(1)
    .max(runtimeKindSchema.options.length)
    .refine((values) => new Set(values).size === values.length)
    .default(['python']),
  gpuIds: gpuIdsSchema,
  maxConcurrentJobs: z.number().int().min(1).max(128),
  enabled: z.boolean(),
  executor: z.enum(['ssh', 'local']),
});
export const jobCreateSchema = z.strictObject({
  runId: uuidSchema,
  targetId: uuidSchema,
  gpuIds: gpuIdsSchema.default([]),
  maxAttempts: maxAttemptsSchema,
});
export const targetPatchSchema = targetSchema.partial().extend({
  runtimeKinds: targetSchema.shape.runtimeKinds.removeDefault().optional(),
});
export const tokenCreateSchema = z.strictObject({
  name: nameSchema,
  kind: z.enum(['personal', 'service']),
  projectId: uuidSchema.nullish(),
  scopes: z
    .array(scopeSchema)
    .min(1)
    .max(7)
    .refine((values) => new Set(values).size === values.length),
  expiresAt: z.iso.datetime({ offset: true }).nullish(),
});
export const pluginCreateSchema = z.strictObject({
  name: nameSchema,
  baseUrl: z
    .url()
    .max(2000)
    .refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, 'An HTTP service URL without credentials is required'),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  enabled: z.boolean().default(true),
});
export const pluginPatchSchema = pluginCreateSchema
  .partial()
  .extend({ enabled: z.boolean().optional() });
export const pluginDatasetSchema = z.strictObject({
  externalId: nameSchema,
  namespace: nameSchema,
  name: nameSchema,
  version: nameSchema,
  uri: z.string().min(1).max(4000),
  digest: z.string().min(1).max(1000),
  schema: jsonObjectSchema,
  metadata: jsonObjectSchema,
});
// A worker reports at most this many parallel jobs; larger values are a misconfiguration.
const MAX_WORKER_PARALLEL_JOBS = 1000;
// Self-reported by the worker host for display only; never used for authorization.
export const workerInfoSchema = z.strictObject({
  version: z.string().trim().min(1).max(200).optional(),
  hostname: z.string().trim().min(1).max(255).optional(),
  parallelJobs: z.number().int().min(1).max(MAX_WORKER_PARALLEL_JOBS).optional(),
});
export const workerResumeSchema = z.strictObject({
  workerId: z.string().min(1).max(200),
  targetIds: uniqueIdsSchema.optional(),
  workerInfo: workerInfoSchema.optional(),
});
export const workerClaimSchema = workerResumeSchema.extend({
  activeJobIds: uniqueIdsSchema.optional(),
});
export const heartbeatSchema = z.strictObject({
  leaseId: uuidSchema,
  status: z.literal('running').optional(),
});
export const workerMetricSchema = metricBatchSchema.extend({ leaseId: uuidSchema });
export const workerLogSchema = logBatchSchema.extend({ leaseId: uuidSchema });
export const completeSchema = z.strictObject({
  leaseId: uuidSchema,
  status: z.enum(['finished', 'failed', 'canceled']),
  exitCode: z.number().int().optional(),
  error: z.string().max(20000).optional(),
});

export type RunCreate = z.infer<typeof runCreateSchema>;
export type RunPatch = z.infer<typeof runPatchSchema>;
export type CodeVersionCreate = z.infer<typeof codeVersionSchema>;
export type ModelVersionCreate = z.infer<typeof modelVersionSchema>;
export type DatasetVersionCreate = z.infer<typeof datasetVersionSchema>;
export type JobCreate = z.infer<typeof jobCreateSchema>;
export type TargetPatch = z.infer<typeof targetPatchSchema>;
export type PluginPatch = z.infer<typeof pluginPatchSchema>;
