import type { TargetCheckResult } from '@mmt/contracts';
import { z } from 'zod';
import { DomainError } from './errors.js';
import { runtimeKindSchema } from './runtimeValidation.js';
import { uuidSchema } from './validation.js';

// The result is a short summary; a larger body means the worker sent raw command output.
export const MAX_TARGET_CHECK_RESULT_BYTES = 16 * 1024;
// Generous for one host (DGX-class machines have 8-16 GPUs).
const MAX_TARGET_CHECK_GPUS = 64;
// Long enough for a version line or a GPU model name, too short for a log dump.
const MAX_DETAIL_LENGTH = 200;

const ITEM_NAMES = [
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
] as const;

const ITEM_CODES = [
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
] as const;

const shortTextSchema = z
  .string()
  .max(MAX_DETAIL_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed');

const itemSchema = z
  .strictObject({
    name: z.enum(ITEM_NAMES),
    status: z.enum(['ok', 'ng', 'unavailable', 'skipped']),
    code: z.enum(ITEM_CODES).nullable(),
    detail: shortTextSchema.nullable(),
  })
  .refine((item) => (item.status === 'ok') === (item.code === null), {
    message: 'Only ok items have no code',
  });

const gpuSchema = z.strictObject({
  index: z.string().regex(/^\d{1,3}$/),
  uuid: shortTextSchema.min(1),
  name: shortTextSchema.min(1),
  memoryTotalMiB: z.number().int().min(0),
});

export const targetCheckResultSchema = z.strictObject({
  version: z.literal(1),
  items: z
    .array(itemSchema)
    .min(1)
    .max(ITEM_NAMES.length)
    .refine((items) => new Set(items.map((item) => item.name)).size === items.length, {
      message: 'Item names must be unique',
    }),
  gpus: z.array(gpuSchema).max(MAX_TARGET_CHECK_GPUS).nullable(),
  runtimeKinds: z
    .array(runtimeKindSchema)
    .refine((kinds) => new Set(kinds).size === kinds.length, { message: 'Must be unique' }),
  workDirectoryFreeBytes: z.number().int().min(0).nullable(),
});

export const targetCheckClaimSchema = z.strictObject({
  workerId: z.string().min(1).max(200),
  // Required: a worker diagnoses only the targets it was explicitly put in charge of.
  targetIds: z
    .array(uuidSchema)
    .min(1)
    .max(1000)
    .refine((values) => new Set(values).size === values.length, 'IDs must be unique'),
});

export const targetCheckCompleteSchema = z.strictObject({
  leaseId: uuidSchema,
  status: z.enum(['finished', 'failed']),
  result: targetCheckResultSchema,
});

// API tokens (mmt_/mmtj_), PEM blocks and the target's own key files must never be stored.
const SECRET_PATTERNS = [/\bmmtj?_[A-Za-z0-9_-]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

function textValues(result: TargetCheckResult): string[] {
  return [
    ...result.items.flatMap((item) => (item.detail === null ? [] : [item.detail])),
    ...(result.gpus ?? []).flatMap((gpu) => [gpu.uuid, gpu.name]),
  ];
}

export function rejectSecretsInResult(
  result: TargetCheckResult,
  target: { sshKeyPath: string; knownHostsPath: string },
): void {
  const secretPaths = [target.sshKeyPath, target.knownHostsPath].filter((path) => path !== '');
  const leaks = textValues(result).some(
    (value) =>
      SECRET_PATTERNS.some((pattern) => pattern.test(value)) ||
      secretPaths.some((path) => value.includes(path)),
  );
  if (leaks)
    throw new DomainError(
      422,
      '診断結果に鍵のパスや認証情報が含まれています',
      'target_check_secret_in_result',
    );
}

export function rejectOversizedResult(result: TargetCheckResult): void {
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_TARGET_CHECK_RESULT_BYTES)
    throw new DomainError(422, '診断結果が上限サイズを超えています', 'target_check_result_too_large');
}
