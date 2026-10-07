import { z } from 'zod';

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

export function isRelativeFilePath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => !!part && part !== '.' && part !== '..')
  );
}
const filePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isRelativeFilePath, 'A safe relative file path is required');

function isGitSourceUrl(value: string): boolean {
  if (/^git@[\w.-]+:[^\s\0]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      !url.password && ((url.protocol === 'https:' && !url.username) || url.protocol === 'ssh:')
    );
  } catch {
    return false;
  }
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
export const codeSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('git'),
    url: z
      .string()
      .min(1)
      .max(2048)
      .refine(isGitSourceUrl, 'Use a Git HTTPS or SSH URL without credentials'),
    commit: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i, 'A full immutable commit is required'),
  }),
  z.strictObject({
    kind: z.literal('inline'),
    files: z
      .record(filePathSchema, z.string().max(2000000))
      .refine((files) => Object.keys(files).length > 0 && Object.keys(files).length <= 1000),
  }),
  z.strictObject({ kind: z.literal('artifact'), artifactId: uuidSchema }),
]);
export const codeVersionSchema = z.strictObject({
  version: nameSchema,
  source: codeSourceSchema,
  entrypoint: z.array(z.string().min(1).max(4000)).min(1).max(100),
  requirements: z.array(z.string().min(1).max(2000)).max(1000).default([]),
  environment: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(10000))
    .default({}),
  supportedModelFamilies: z.array(nameSchema).min(1).max(100),
  taskTypes: z.array(runKindSchema).min(1).max(5),
});
export const modelVersionSchema = z.strictObject({
  version: nameSchema,
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
export const logBatchSchema = z.strictObject({ entries: z.array(logSchema).min(1).max(1000) });
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
  gpuIds: z
    .array(z.string().min(1).max(100))
    .max(128)
    .refine((values) => new Set(values).size === values.length),
  maxConcurrentJobs: z.number().int().min(1).max(128),
  enabled: z.boolean(),
  executor: z.enum(['ssh', 'local']),
});
export const jobCreateSchema = z.strictObject({
  runId: uuidSchema,
  targetId: uuidSchema,
  gpuIds: z
    .array(z.string().min(1).max(100))
    .max(128)
    .refine((values) => new Set(values).size === values.length)
    .default([]),
  maxAttempts: z.number().int().min(1).max(100).default(3),
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
export const workerResumeSchema = z.strictObject({
  workerId: z.string().min(1).max(200),
  targetIds: uniqueIdsSchema.optional(),
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
