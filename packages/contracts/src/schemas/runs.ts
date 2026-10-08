import { z } from 'zod';
import type { CodeSource, ExecutionRuntime, LogEntry, MetricPoint, Run } from '../index.js';
import type { ExecutionSnapshot, TaskOutputModel } from '../experimentTasks.js';
import {
  idSchema,
  jsonObjectSchema,
  runKindSchema,
  runStatusSchema,
  stringMapSchema,
  timestampSchema,
} from './primitives.js';
import { describedField, namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const executionRuntimeSchema = namedContractSchema(
  'ExecutionRuntime',
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('python') }),
    z.strictObject({
      kind: z.literal('docker'),
      image: z.string(),
      workingDirectory: z.string().optional(),
    }),
    z.strictObject({
      kind: z.enum(['singularity', 'apptainer']),
      artifactId: idSchema,
      sha256: z.string(),
      workingDirectory: z.string().optional(),
    }),
  ]),
);
export const codeSourceSchema = namedContractSchema(
  'CodeSource',
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('git'),
      url: z.string(),
      commit: z.string(),
      files: stringMapSchema.optional(),
      deletedFiles: z.array(z.string()).optional(),
    }),
    z.strictObject({ kind: z.literal('inline'), files: stringMapSchema }),
    z.strictObject({ kind: z.literal('artifact'), artifactId: idSchema }),
  ]),
);
// Kept here rather than in experimentTasks.ts: Run embeds both, and TaskExecution embeds Run.
export const executionSnapshotSchema = namedContractSchema(
  'ExecutionSnapshot',
  z.strictObject({
    codeVersionId: idSchema,
    version: z.string(),
    mode: z.enum(['run', 'test']),
    source: codeSourceSchema.nullable(),
    runtime: executionRuntimeSchema,
    entrypoint: z.array(z.string()),
    requirements: z.array(z.string()),
    environment: stringMapSchema,
  }),
);
export const taskOutputModelSchema = namedContractSchema(
  'TaskOutputModel',
  z.strictObject({
    modelId: idSchema.nullable(),
    createModel: z.strictObject({ name: z.string(), family: z.string() }).nullable(),
    artifactPath: z.string(),
    versionTemplate: z.string().optional(),
    defaultCodeVersionId: idSchema.nullable().optional(),
    metadata: jsonObjectSchema.optional(),
  }),
);
export const metricPointSchema = namedContractSchema(
  'MetricPoint',
  z.strictObject({
    name: z.string(),
    value: z.number(),
    step: z.number(),
    timestamp: timestampSchema,
  }),
);
export const logEntrySchema = namedContractSchema(
  'LogEntry',
  z.strictObject({
    timestamp: timestampSchema,
    level: z.enum(['info', 'warning', 'error']),
    message: z.string(),
  }),
);
export const runSchema = namedContractSchema(
  'Run',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    experimentId: idSchema,
    name: z.string(),
    kind: runKindSchema,
    status: runStatusSchema,
    parameters: jsonObjectSchema,
    recordedParameters: jsonObjectSchema.optional(),
    tags: stringMapSchema,
    latestMetrics: z.record(z.string(), z.number()),
    modelVersionId: idSchema.nullable(),
    codeVersionId: idSchema.nullable(),
    taskId: idSchema.nullable().optional(),
    taskRevision: z.number().int().nullable().optional(),
    executionMode: z.enum(['run', 'test']).optional(),
    executionSnapshot: executionSnapshotSchema.nullable().optional(),
    inputDatasetVersionIds: z.array(idSchema),
    upstreamDatasetVersionIds: z.array(idSchema),
    outputDatasetVersionIds: z.array(idSchema),
    outputModelVersionIds: z.array(idSchema),
    outputModelRegistration: taskOutputModelSchema.nullable().optional(),
    parentRunId: idSchema.nullable(),
    resumeCheckpointId: idSchema.nullable().optional(),
    environment: jsonObjectSchema,
    createdBy: idSchema,
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
    error: z.string().nullable(),
    syncOrigin: z.string().nullable().optional(),
    // The native API returns these MLflow bookkeeping columns although the Run type omits them;
    // declared so the published schema matches the responses (reported to the contract owner).
    lifecycleStage: describedField(
      z.enum(['active', 'deleted']).optional(),
      'MLflowの削除状態。contractsのRun型には無いが、native APIの応答に含まれる',
    ),
    mlflowManaged: describedField(
      z.boolean().optional(),
      'MLflow互換APIで作ったRunか。contractsのRun型には無いが、native APIの応答に含まれる',
    ),
    mlflowUserId: describedField(
      z.string().nullable().optional(),
      'MLflowのuser_id。contractsのRun型には無いが、native APIの応答に含まれる',
    ),
  }),
);

type _ExecutionRuntime = Expect<
  MutuallyAssignable<z.infer<typeof executionRuntimeSchema>, ExecutionRuntime>
>;
type _CodeSource = Expect<MutuallyAssignable<z.infer<typeof codeSourceSchema>, CodeSource>>;
type _ExecutionSnapshot = Expect<
  MutuallyAssignable<z.infer<typeof executionSnapshotSchema>, ExecutionSnapshot>
>;
type _TaskOutputModel = Expect<
  MutuallyAssignable<z.infer<typeof taskOutputModelSchema>, TaskOutputModel>
>;
type _MetricPoint = Expect<MutuallyAssignable<z.infer<typeof metricPointSchema>, MetricPoint>>;
type _LogEntry = Expect<MutuallyAssignable<z.infer<typeof logEntrySchema>, LogEntry>>;
type _Run = Expect<MutuallyAssignable<z.infer<typeof runSchema>, Run>>;
