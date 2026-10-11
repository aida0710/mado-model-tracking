import { z } from 'zod';
import type { ComputeTarget, Job, JobListItem, WorkerPresence } from '../index.js';
import { CPU_ARCHES, JOB_END_REASONS, JOB_PHASES, SITE_SUBMISSION_MODES } from '../siteExecution.js';
import { COMPUTE_TARGET_VISIBILITIES } from '../computeTargetAccess.js';
import { idSchema, jobStatusSchema, runKindSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const executionRuntimeKindSchema = z.enum(['python', 'docker', 'singularity', 'apptainer']);
export const computeTargetExecutorSchema = z.enum(['ssh', 'local', 'site']);
export const siteSubmissionModeSchema = z.enum(SITE_SUBMISSION_MODES);
export const cpuArchSchema = z.enum(CPU_ARCHES);
export const jobPhaseSchema = z.enum(JOB_PHASES);
export const jobEndReasonSchema = z.enum(JOB_END_REASONS);
export const computeTargetVisibilitySchema = z.enum(COMPUTE_TARGET_VISIBILITIES);
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
    executor: computeTargetExecutorSchema,
    datasetCacheMaxBytes: z.number().int(),
    datasetTransfer: z.enum(['relay', 'direct']),
    submissionMode: siteSubmissionModeSchema,
    cpuArch: cpuArchSchema,
    supportsArray: z.boolean(),
    queueTimeoutSeconds: z.number().int().nullable(),
    ownerUserId: idSchema.nullable(),
    visibility: computeTargetVisibilitySchema,
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
    phase: jobPhaseSchema.nullable(),
    gpuCount: z.number().int(),
    walltimeSeconds: z.number().int().nullable(),
    schedulerJobId: z.string().nullable(),
    submittedAt: timestampSchema.nullable(),
    runnerHost: z.string().nullable(),
    arrayGroupId: idSchema.nullable(),
    arrayIndex: z.number().int().nullable(),
    arraySize: z.number().int().nullable(),
    endReason: jobEndReasonSchema.nullable(),
    parentJobId: idSchema.nullable(),
    chainDepth: z.number().int(),
    hookId: idSchema.nullable(),
    allowChildJobs: z.boolean(),
    retryOnFailure: z.boolean(),
    retryOnTimeout: z.boolean(),
    datasetPartitionVersionId: idSchema.nullable(),
    siteJobShellId: idSchema.nullable(),
  }),
);
export const jobListItemSchema = namedContractSchema(
  'JobListItem',
  jobSchema.extend({
    runName: z.string(),
    runKind: runKindSchema,
    taskId: idSchema.nullable(),
    taskName: z.string().nullable(),
    sweepEarlyStopped: z.boolean(),
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
type _JobListItem = Expect<MutuallyAssignable<z.infer<typeof jobListItemSchema>, JobListItem>>;
type _WorkerPresence = Expect<
  MutuallyAssignable<z.infer<typeof workerPresenceSchema>, WorkerPresence>
>;
