import { z } from 'zod';
import type {
  TargetCheck,
  TargetCheckGpu,
  TargetCheckItem,
  TargetCheckResult,
  WorkerTargetCheck,
} from '../targetChecks.js';
import { computeTargetSchema, executionRuntimeKindSchema } from './execution.js';
import { idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const targetCheckItemSchema = namedContractSchema(
  'TargetCheckItem',
  z.strictObject({
    name: z.enum([
      'connection',
      'python',
      'venv',
      'pip',
      'git',
      'docker',
      'apptainer',
      'singularity',
      'gpu',
      'work_directory',
      'api',
    ]),
    status: z.enum(['ok', 'ng', 'unavailable', 'skipped']),
    code: z
      .enum([
        'ssh_failed',
        'ssh_configuration',
        'probe_failed',
        'python_missing',
        'python_too_old',
        'venv_missing',
        'pip_missing',
        'git_missing',
        'docker_missing',
        'docker_socket_denied',
        'docker_daemon_unreachable',
        'container_cli_missing',
        'container_flags_missing',
        'nvidia_smi_missing',
        'nvidia_smi_failed',
        'work_directory_not_writable',
        'api_unreachable',
        'connection_failed',
      ])
      .nullable(),
    detail: z.string().nullable(),
  }),
);
export const targetCheckGpuSchema = namedContractSchema(
  'TargetCheckGpu',
  z.strictObject({
    index: z.string(),
    uuid: z.string(),
    name: z.string(),
    memoryTotalMiB: z.number().int(),
  }),
);
export const targetCheckResultSchema = namedContractSchema(
  'TargetCheckResult',
  z.strictObject({
    version: z.literal(1),
    items: z.array(targetCheckItemSchema),
    gpus: z.array(targetCheckGpuSchema).nullable(),
    runtimeKinds: z.array(executionRuntimeKindSchema),
    workDirectoryFreeBytes: z.number().int().nullable(),
  }),
);
export const targetCheckSchema = namedContractSchema(
  'TargetCheck',
  z.strictObject({
    id: idSchema,
    targetId: idSchema,
    requestedBy: idSchema,
    status: z.enum(['queued', 'claimed', 'finished', 'failed']),
    workerId: z.string().nullable(),
    result: targetCheckResultSchema.nullable(),
    failureReason: z.enum(['no_worker', 'claim_timeout']).nullable(),
    createdAt: timestampSchema,
    claimedAt: timestampSchema.nullable(),
    finishedAt: timestampSchema.nullable(),
  }),
);
export const workerTargetCheckSchema = namedContractSchema(
  'WorkerTargetCheck',
  z.strictObject({ check: targetCheckSchema, leaseId: idSchema, target: computeTargetSchema }),
);

type _TargetCheckItem = Expect<
  MutuallyAssignable<z.infer<typeof targetCheckItemSchema>, TargetCheckItem>
>;
type _TargetCheckGpu = Expect<
  MutuallyAssignable<z.infer<typeof targetCheckGpuSchema>, TargetCheckGpu>
>;
type _TargetCheckResult = Expect<
  MutuallyAssignable<z.infer<typeof targetCheckResultSchema>, TargetCheckResult>
>;
type _TargetCheck = Expect<MutuallyAssignable<z.infer<typeof targetCheckSchema>, TargetCheck>>;
type _WorkerTargetCheck = Expect<
  MutuallyAssignable<z.infer<typeof workerTargetCheckSchema>, WorkerTargetCheck>
>;
