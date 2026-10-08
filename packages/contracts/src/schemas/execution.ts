import { z } from 'zod';
import type { ComputeTarget, Job, WorkerPresence } from '../index.js';
import { idSchema, jobStatusSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const executionRuntimeKindSchema = z.enum(['python', 'docker', 'singularity', 'apptainer']);
export const computeTargetSchema = namedContractSchema(
  'ComputeTarget',
  z.strictObject({
    id: idSchema,
    name: z.string(),
    host: z.string(),
    port: z.number().int(),
    username: z.string(),
    sshKeyPath: z.string(),
    knownHostsPath: z.string(),
    workDirectory: z.string(),
    pythonExecutable: z.string(),
    runtimeKinds: z.array(executionRuntimeKindSchema),
    gpuIds: z.array(z.string()),
    maxConcurrentJobs: z.number().int(),
    enabled: z.boolean(),
    executor: z.enum(['ssh', 'local']),
    datasetCacheMaxBytes: z.number().int(),
    datasetTransfer: z.enum(['relay', 'direct']),
  }),
);
export const jobSchema = namedContractSchema(
  'Job',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    runId: idSchema,
    targetId: idSchema,
    status: jobStatusSchema,
    gpuIds: z.array(z.string()),
    workerId: z.string().nullable(),
    leaseId: idSchema.nullable(),
    cancelRequested: z.boolean(),
    attempt: z.number().int(),
    maxAttempts: z.number().int(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
    heartbeatAt: timestampSchema.nullable(),
    exitCode: z.number().int().nullable(),
    error: z.string().nullable(),
    heartbeatStale: z.boolean(),
  }),
);
export const workerPresenceSchema = namedContractSchema(
  'WorkerPresence',
  z.strictObject({
    projectId: idSchema,
    tokenId: idSchema,
    tokenName: z.string(),
    workerId: z.string(),
    version: z.string().nullable(),
    hostname: z.string().nullable(),
    targetIds: z.array(idSchema).nullable(),
    parallelJobs: z.number().int().nullable(),
    startedAt: timestampSchema,
    lastSeenAt: timestampSchema,
    status: z.enum(['online', 'offline']),
    activeJobCount: z.number().int(),
  }),
);

type _ComputeTarget = Expect<
  MutuallyAssignable<z.infer<typeof computeTargetSchema>, ComputeTarget>
>;
type _Job = Expect<MutuallyAssignable<z.infer<typeof jobSchema>, Job>>;
type _WorkerPresence = Expect<
  MutuallyAssignable<z.infer<typeof workerPresenceSchema>, WorkerPresence>
>;
